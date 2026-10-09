const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const HTTP_CODE = {
  "invalid-argument": 400,
  "unauthenticated": 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  "failed-precondition": 400,
  "resource-exhausted": 429,
  "internal": 500,
};

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.send("ok"));

async function authOf(req) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return null;
  try {
    const token = await admin.auth().verifyIdToken(h.slice(7));
    return { uid: token.uid, token };
  } catch (e) {
    return null;
  }
}

function callable(name, fn) {
  app.post("/" + name, async (req, res) => {
    try {
      const auth = await authOf(req);
      const result = await fn({ data: (req.body && req.body.data) || {}, auth, rawRequest: req });
      res.json({ result });
    } catch (e) {
      const code = e instanceof HttpsError ? e.code : "internal";
      if (code === "internal") console.error(name, e);
      res.status(HTTP_CODE[code] || 500).json({
        error: {
          message: code === "internal" ? "Something went wrong. Try again." : e.message,
          status: code.toUpperCase().replace(/-/g, "_"),
        },
      });
    }
  });
}

const DEAD_TOKEN = [
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
];

async function send(username, notification, data, channelId, ttl, tag) {
  const snap = await db.collection("users").where("username", "==", username).limit(1).get();
  if (snap.empty) return false;
  const ref = snap.docs[0].ref;
  const tokens = ["fcm", "webfcm"].map((f) => [f, snap.docs[0].get(f)]).filter((t) => t[1]);
  if (!tokens.length) {
    console.log("no push token for", username);
    return false;
  }
  let ok = false;
  const strData = Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v == null ? "" : v)]));
  await Promise.all(
    tokens.map(async ([field, token]) => {
      try {
        await admin.messaging().send({
          token,
          notification,
          data: strData,
          android: {
            priority: "high",
            ttl,
            notification: Object.assign(
              { channelId, sound: "default", defaultVibrateTimings: true, visibility: "public", notificationPriority: "PRIORITY_MAX" },
              tag ? { tag } : {}
            ),
          },
          webpush: {
            headers: { Urgency: "high", TTL: String(Math.floor(ttl / 1000)) },
            notification: Object.assign({ icon: "icon-192.png" }, tag ? { tag, renotify: true } : {}),
          },
        });
        ok = true;
      } catch (e) {
        console.error("push failed for", username, field, e.code || e.message);
        if (DEAD_TOKEN.includes(e.code)) {
          await ref.update({ [field]: admin.firestore.FieldValue.delete() }).catch(() => {});
        }
      }
    })
  );
  return ok;
}

async function markDelivered(chat, username, t) {
  if (!chat || !username || !(t > 0)) return;
  const ref = db.collection("rcpt").doc(chat).collection("u").doc(username);
  try {
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const d = (cur.exists && cur.get("d")) || 0;
      if (t > d) tx.set(ref, { d: t }, { merge: true });
    });
  } catch (e) {
    console.error("delivered mark failed", username, e.message);
  }
}

async function claimCallPush(chat, to) {
  const ref = db.collection("callpush").doc(chat + "__" + to);
  try {
    return await db.runTransaction(async (tx) => {
      const d = await tx.get(ref);
      const t = d.exists ? d.get("t") || 0 : 0;
      if (Date.now() - t < 20000) return false;
      tx.set(ref, { t: Date.now() });
      return true;
    });
  } catch (e) {
    return true;
  }
}

const fresh = (c) => {
  const now = Date.now();
  return Object.entries((c && c.p) || {})
    .filter(([, v]) => v && v.toMillis && now - v.toMillis() < 60000)
    .map(([k]) => k);
};

async function handlePing(p) {
  if (p.kind === "call") {
    const dm = p.chat.startsWith("dm_");
    if (await claimCallPush(p.chat, p.to)) {
      await send(
        p.to,
        { title: dm ? `${p.from} is calling` : `${p.from} started a call in ${p.title}`, body: dm ? "Tap to answer" : "Tap to join" },
        { type: "call", chat: p.chat, title: p.title },
        "calls",
        30000,
        "call_" + p.chat
      );
    }
    return;
  }
  const ok = await send(
    p.to,
    { title: p.chat.startsWith("dm_") ? `${p.from} pinged you` : `${p.from} pinged you in ${p.title}`, body: p.text || "" },
    { type: "ping", chat: p.chat, title: p.title },
    "pings",
    3600 * 1000,
    "ping_" + p.chat
  );
  if (ok && p.t) await markDelivered(p.chat, p.to, p.t);
}

async function handleMessage(chat, m) {
  if (!m || !m.from) return;
  let targets;
  let title;
  let chatName = m.from;
  if (chat.startsWith("dm_")) {
    targets = chat.slice(3).split("__").filter((u) => u !== m.from);
    title = m.from;
  } else {
    const g = await db.collection("groups").doc(chat).get();
    if (!g.exists) return;
    chatName = g.get("name") || "a group";
    targets = (g.get("members") || []).filter((u) => u !== m.from);
    title = `${m.from} in ${chatName}`;
  }
  const mentioned = new Set(m.mentions || []);
  targets = targets.filter((u) => !mentioned.has(u));
  if (!targets.length) return;
  if (m.call && m.call.ans) return;
  const body = m.call
    ? "Missed call"
    : m.text
    ? String(m.text).slice(0, 140)
    : m.music
    ? "Music: " + String((m.music && m.music.name) || "").slice(0, 60)
    : m.voice
    ? "Voice message"
    : m.img
    ? "Photo"
    : m.file
    ? "File: " + (m.fname || "")
    : "New message";
  await Promise.all(
    targets.map(async (u) => {
      const ok = await send(u, { title, body }, { type: "msg", chat, title: chatName, mt: m.t }, "messages", 3600 * 1000, m.call ? "call_" + chat : "msg_" + chat);
      if (ok) await markDelivered(chat, u, m.t);
    })
  );
}

async function handleCall(id, before, after) {
  if (!after) return;
  if (fresh(before).length) return;
  const now = fresh(after);
  if (!now.length) return;
  const caller = now[0];
  const targets = (after.invited || []).filter((u) => u !== caller);
  if (!targets.length) return;
  let head = `${caller} is calling`;
  let body = "Tap to answer";
  let title = caller;
  if (!id.startsWith("dm_")) {
    const g = await db.collection("groups").doc(id).get();
    const name = g.exists ? g.get("name") : "a group";
    head = `${caller} started a call in ${name}`;
    body = "Tap to join";
    title = name;
  }
  await Promise.all(
    targets.map(async (u) => {
      if (await claimCallPush(id, u)) await send(u, { title: head, body }, { type: "call", chat: id, title }, "calls", 30000, "call_" + id);
    })
  );
}

async function handleGroup(id, prevMembers, after) {
  if (!after || after.meeting) return;
  const prev = new Set(prevMembers || []);
  const added = (after.members || []).filter((u) => !prev.has(u) && u !== after.owner);
  if (!added.length) return;
  const name = after.name || "a group";
  await Promise.all(
    added.map((u) =>
      send(u, { title: "Added to a group", body: `You were added to ${name}` }, { type: "group", chat: id, title: name }, "messages", 3600 * 1000, "grp_" + id)
    )
  );
}

async function handleRequest(beforeStatus, after) {
  if (!after) return;
  if (after.status === "pending" && beforeStatus !== "pending") {
    await send(
      after.to,
      { title: "New friend request", body: `${after.from} wants to be your friend` },
      { type: "friend", from: after.from },
      "messages",
      24 * 3600 * 1000,
      "req_" + after.from
    );
  } else if (after.status === "accepted" && beforeStatus != null && beforeStatus !== "accepted") {
    const chat = "dm_" + [after.from, after.to].sort().join("__");
    await send(
      after.from,
      { title: "Friend request accepted", body: `${after.to} accepted your request. Say hi!` },
      { type: "msg", chat, title: after.to },
      "messages",
      24 * 3600 * 1000,
      "acc_" + after.to
    );
  }
}

const seen = new Set();
function firstTime(key) {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return true;
}

function watch(name, makeQuery, handler) {
  const start = () => {
    let initial = true;
    makeQuery().onSnapshot(
      (snap) => {
        const wasInitial = initial;
        initial = false;
        handler(snap, wasInitial).catch((e) => console.error(name, e.message));
      },
      (err) => {
        console.error(name, "listener error:", err.message);
        setTimeout(start, 15000);
      }
    );
  };
  start();
}

function startListeners() {
  watch("pings", () => db.collection("pings"), async (snap, initial) => {
    for (const ch of snap.docChanges()) {
      if (ch.type !== "added") continue;
      const p = ch.doc.data();
      if (initial && !(p.t && p.t > Date.now() - 60000)) continue;
      if (!firstTime(ch.doc.ref.path)) continue;
      await handlePing(p);
    }
  });

  watch("messages", () => db.collectionGroup("items").where("t", ">", Date.now() - 600000), async (snap, initial) => {
    for (const ch of snap.docChanges()) {
      if (ch.type !== "added") continue;
      const m = ch.doc.data();
      if (initial && !(m.t > Date.now() - 60000)) continue;
      if (!firstTime(ch.doc.ref.path)) continue;
      const chat = ch.doc.ref.parent.parent && ch.doc.ref.parent.parent.id;
      if (!chat) continue;
      await handleMessage(chat, m);
    }
  });

  const callState = new Map();
  watch("calls", () => db.collection("calls"), async (snap, initial) => {
    for (const ch of snap.docChanges()) {
      const id = ch.doc.id;
      if (ch.type === "removed") {
        callState.delete(id);
        continue;
      }
      const after = ch.doc.data();
      const known = callState.has(id);
      const before = callState.get(id) || null;
      callState.set(id, after);
      if (initial && !known) continue;
      await handleCall(id, before, after);
    }
  });

  const groupState = new Map();
  watch("groups", () => db.collection("groups"), async (snap, initial) => {
    for (const ch of snap.docChanges()) {
      const id = ch.doc.id;
      if (ch.type === "removed") {
        groupState.delete(id);
        continue;
      }
      const after = ch.doc.data();
      const known = groupState.has(id);
      const prev = groupState.get(id) || [];
      groupState.set(id, after.members || []);
      if (initial && !known) continue;
      await handleGroup(id, prev, after);
    }
  });

  const requestState = new Map();
  watch("requests", () => db.collection("requests"), async (snap, initial) => {
    for (const ch of snap.docChanges()) {
      const id = ch.doc.id;
      if (ch.type === "removed") {
        requestState.delete(id);
        continue;
      }
      const after = ch.doc.data();
      const known = requestState.has(id);
      const prev = known ? requestState.get(id) : null;
      requestState.set(id, after.status);
      if (initial && !known) continue;
      await handleRequest(prev, after);
    }
  });
}

callable("verifyEmail", async (req) => {
  const d = req.data || {};
  const token = String(d.token || "");
  const u = String(d.u || "").toLowerCase();
  if (!token || !/^[a-z0-9_]{3,20}$/.test(u)) throw new HttpsError("invalid-argument", "Missing information.");

  let dec;
  try {
    dec = await admin.auth().verifyIdToken(token);
  } catch (e) {
    throw new HttpsError("unauthenticated", "This verification link could not be checked. Request a new email.");
  }
  const email = String(dec.email || "").toLowerCase();
  if (!email || !dec.email_verified) throw new HttpsError("failed-precondition", "That email is not verified yet.");

  try {
    await admin.auth().getUserByEmail(u + "@grouphangout.app");
  } catch (e) {
    throw new HttpsError("not-found", "That account does not exist.");
  }

  const pend = await db.collection("emailpending").doc(u).get();
  if (!pend.exists || String(pend.get("email") || "").toLowerCase() !== email) {
    throw new HttpsError("permission-denied", "This email does not match the one used for the account.");
  }
  const dup = await db.collection("verified").where("email", "==", email).limit(2).get();
  if (dup.docs.some((x) => x.id !== u)) {
    throw new HttpsError("already-exists", "This email is already used by another account.");
  }
  await db.collection("verified").doc(u).set({ email, t: Date.now() });
  return { ok: true };
});


const ADMIN_NAME_RE = /^[a-z0-9_]{3,20}$/;
const SESSION_MS = 8 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const PERMANENT = 9e15;

function ipOf(req) {
  try {
    const h = req.rawRequest && req.rawRequest.headers;
    const xf = h && h["x-forwarded-for"];
    return String((xf ? String(xf).split(",")[0] : req.rawRequest && req.rawRequest.ip) || "unknown").trim().slice(0, 60);
  } catch (e) {
    return "unknown";
  }
}

function hashPw(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

let secretCache = null;
async function sessionSecret() {
  if (secretCache) return secretCache;
  const ref = db.collection("adminSetup").doc("secret");
  const k = await db.runTransaction(async (tx) => {
    const d = await tx.get(ref);
    if (d.exists && d.get("k")) return d.get("k");
    const nk = crypto.randomBytes(48).toString("base64");
    tx.set(ref, { k: nk, t: Date.now() });
    return nk;
  });
  secretCache = k;
  return k;
}

async function signSession(a) {
  const body = Buffer.from(JSON.stringify({ a: a.name, r: a.role, sv: a.sv || 0, exp: Date.now() + SESSION_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", await sessionSecret()).update(body).digest("base64url");
  return body + "." + sig;
}

async function logAdmin(adminName, action, target, details, ip) {
  try {
    await db.collection("adminLogs").add({ admin: adminName, action, target: target || "", details: details || {}, ip: ip || "", t: Date.now() });
  } catch (e) {
    console.error("log failed", e.message);
  }
}
async function logSec(type, adminName, target, details, ip) {
  try {
    await db.collection("securityLogs").add({ type, admin: adminName || "", target: target || "", details: details || {}, ip: ip || "", t: Date.now() });
  } catch (e) {
    console.error("seclog failed", e.message);
  }
}

async function requireAdmin(req, roles) {
  const tok = String((req.data && req.data.session) || "");
  const parts = tok.split(".");
  if (parts.length !== 2) throw new HttpsError("unauthenticated", "Please sign in again.");
  const expect = crypto.createHmac("sha256", await sessionSecret()).update(parts[0]).digest("base64url");
  if (!safeEq(parts[1], expect)) throw new HttpsError("unauthenticated", "Please sign in again.");
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  } catch (e) {
    throw new HttpsError("unauthenticated", "Please sign in again.");
  }
  if (!p || !p.exp || p.exp < Date.now()) throw new HttpsError("unauthenticated", "Your session expired. Sign in again.");
  const d = await db.collection("admins").doc(String(p.a)).get();
  if (!d.exists || d.get("disabled") || (d.get("sv") || 0) !== (p.sv || 0)) throw new HttpsError("unauthenticated", "Please sign in again.");
  const adm = { name: d.id, role: d.get("role") || "admin", ip: ipOf(req) };
  if (roles && !roles.includes(adm.role)) throw new HttpsError("permission-denied", "You do not have permission to do that.");
  return adm;
}

function cleanName(x) {
  const u = String(x || "").toLowerCase().trim();
  if (!/^[a-z0-9_]{3,20}$/.test(u)) throw new HttpsError("invalid-argument", "That is not a valid username.");
  return u;
}
function cleanReason(x, min) {
  const r = String(x || "").trim().slice(0, 300);
  if (r.length < (min || 3)) throw new HttpsError("invalid-argument", "Please enter a reason.");
  return r;
}
async function authUserOf(u) {
  try {
    return await admin.auth().getUserByEmail(u + "@grouphangout.app");
  } catch (e) {
    return null;
  }
}


callable("adminSetup", async (req) => {
  const ip = ipOf(req);
  const d = req.data || {};
  const name = String(d.name || "").toLowerCase().trim();
  const password = String(d.password || "");
  if (!ADMIN_NAME_RE.test(name)) throw new HttpsError("invalid-argument", "Admin name: 3 to 20 letters, numbers or _.");
  if (password.length < 10) throw new HttpsError("invalid-argument", "Use a password of at least 10 characters.");
  const any = await db.collection("admins").limit(1).get();
  if (!any.empty) throw new HttpsError("failed-precondition", "Setup is already done.");
  const s = await db.collection("adminSetup").doc("setup").get();
  const code = s.exists ? String(s.get("code") || "") : "";
  if (!code || !safeEq(code, String(d.code || ""))) {
    await logSec("setup_failed", name, "", {}, ip);
    throw new HttpsError("permission-denied", "The setup code is wrong, or it has not been created in Firebase yet.");
  }
  const h = hashPw(password);
  await db.collection("admins").doc(name).set({ role: "owner", salt: h.salt, hash: h.hash, sv: 0, disabled: false, created: Date.now(), by: "setup" });
  await s.ref.delete();
  await logAdmin(name, "admin_setup", name, {}, ip);
  await logSec("setup_done", name, name, {}, ip);
  return { ok: true };
});

callable("adminLogin", async (req) => {
  const ip = ipOf(req);
  const name = String((req.data && req.data.name) || "").toLowerCase().trim();
  const password = String((req.data && req.data.password) || "");
  const ref = db.collection("adminAttempts").doc(crypto.createHash("sha256").update(name + "|" + ip).digest("hex").slice(0, 40));
  const refName = db.collection("adminAttempts").doc("n_" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 40));
  const [a1, a2] = await Promise.all([ref.get(), refName.get()]);
  const lockedUntil = Math.max((a1.exists && a1.get("until")) || 0, (a2.exists && a2.get("until")) || 0);
  if (lockedUntil > Date.now()) {
    await logSec("login_blocked", name, "", {}, ip);
    throw new HttpsError("resource-exhausted", "Too many wrong attempts. Try again in " + Math.ceil((lockedUntil - Date.now()) / 60000) + " minutes.");
  }
  const ad = ADMIN_NAME_RE.test(name) ? await db.collection("admins").doc(name).get() : null;
  const h = hashPw(password, ad && ad.exists ? ad.get("salt") : "00".repeat(16));
  const ok = !!(ad && ad.exists && !ad.get("disabled") && safeEq(h.hash, ad.get("hash")));
  if (!ok) {
    const bump = async (r, snap) => {
      const n = ((snap.exists && snap.get("n")) || 0) + 1;
      await r.set({ n: n >= MAX_FAILS ? 0 : n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0, t: Date.now() });
      return n;
    };
    const n = await bump(ref, a1);
    await bump(refName, a2);
    await logSec("login_failed", name, "", { attempt: n }, ip);
    throw new HttpsError("permission-denied", "Wrong admin name or password.");
  }
  await Promise.all([ref.delete().catch(() => {}), refName.delete().catch(() => {})]);
  const token = await signSession({ name, role: ad.get("role") || "admin", sv: ad.get("sv") || 0 });
  await logAdmin(name, "login", "", {}, ip);
  await logSec("login_ok", name, "", {}, ip);
  return { session: token, name, role: ad.get("role") || "admin", expires: Date.now() + SESSION_MS };
});

callable("adminSearch", async (req) => {
  const adm = await requireAdmin(req);
  const q = String((req.data && req.data.q) || "").toLowerCase().trim().slice(0, 60);
  let names = [];
  if (q.includes("@")) {
    const s = await db.collection("users").where("email", "==", q).limit(20).get();
    names = s.docs.map((x) => x.get("username")).filter(Boolean);
  } else {
    let query = db.collection("profiles").orderBy(admin.firestore.FieldPath.documentId());
    if (q) query = query.startAt(q).endAt(q + "\uf8ff");
    const s = await query.limit(30).get();
    names = s.docs.map((x) => x.id);
  }
  const out = await Promise.all(
    names.map(async (u) => {
      const [p, t] = await Promise.all([db.collection("profiles").doc(u).get(), db.collection("terminated").doc(u).get()]);
      return { u, name: (p.exists && p.get("name")) || "", susp: (p.exists && p.get("susp")) || 0, terminated: t.exists };
    })
  );
  await logAdmin(adm.name, "search", "", { q }, adm.ip);
  return { users: out };
});

callable("adminUser", async (req) => {
  const adm = await requireAdmin(req);
  const u = cleanName(req.data && req.data.u);
  const rec = await authUserOf(u);
  const [prof, pend, ver, susp, term, pres, fr, gr] = await Promise.all([
    db.collection("profiles").doc(u).get(),
    db.collection("emailpending").doc(u).get(),
    db.collection("verified").doc(u).get(),
    db.collection("suspensions").doc(u).get(),
    db.collection("terminated").doc(u).get(),
    db.collection("presence").doc(u).get(),
    db.collection("friends").where("members", "array-contains", u).get(),
    db.collection("groups").where("members", "array-contains", u).get(),
  ]);
  let devices = [];
  let uDoc = null;
  if (rec) {
    uDoc = await db.collection("users").doc(rec.uid).get();
    const dv = await db.collection("users").doc(rec.uid).collection("devices").limit(20).get();
    devices = dv.docs.map((d) => ({ label: d.get("label") || d.get("type") || "Device", app: !!d.get("app"), last: d.get("last") ? d.get("last").toMillis() : 0 }));
  }
  const logs = await db.collection("adminLogs").where("target", "==", u).limit(40).get();
  await logAdmin(adm.name, "view_user", u, {}, adm.ip);
  return {
    u,
    exists: !!rec,
    uid: rec ? rec.uid : "",
    created: rec ? Date.parse(rec.metadata.creationTime) : 0,
    lastSignIn: rec && rec.metadata.lastSignInTime ? Date.parse(rec.metadata.lastSignInTime) : 0,
    authDisabled: rec ? !!rec.disabled : false,
    displayName: prof.exists ? prof.get("name") || "" : "",
    bio: prof.exists ? prof.get("bio") || "" : "",
    hasAvatar: prof.exists ? !!prof.get("avatar") : false,
    hasProfile: prof.exists,
    email: (uDoc && uDoc.exists && uDoc.get("email")) || (pend.exists && pend.get("email")) || "",
    verified: ver.exists,
    verifiedEmail: ver.exists ? ver.get("email") : "",
    online: pres.exists ? { on: !!pres.get("on"), t: pres.get("t") || 0 } : null,
    suspension: susp.exists ? { until: susp.get("until") || 0, reason: susp.get("reason") || "", by: susp.get("by") || "", t: susp.get("t") || 0 } : null,
    terminated: term.exists ? { reason: term.get("reason") || "", by: term.get("by") || "", t: term.get("t") || 0 } : null,
    friends: fr.docs.map((d) => (d.get("members") || []).find((x) => x !== u)).filter(Boolean).sort(),
    groups: gr.docs.map((d) => ({ id: d.id, name: d.get("name") || "", owner: d.get("owner") === u, meeting: !!d.get("meeting"), members: (d.get("members") || []).length })),
    devices,
    history: logs.docs.map((d) => d.data()).sort((a, b) => b.t - a.t).slice(0, 20),
  };
});

callable("adminSuspend", async (req) => {
  const adm = await requireAdmin(req);
  const u = cleanName(req.data && req.data.u);
  const reason = cleanReason(req.data && req.data.reason);
  const permanent = !!(req.data && req.data.permanent);
  const minutes = Math.floor(Number(req.data && req.data.minutes));
  if (!permanent && !(minutes >= 1 && minutes <= 525600 * 5)) throw new HttpsError("invalid-argument", "Pick how long the suspension lasts.");
  const prof = await db.collection("profiles").doc(u).get();
  const rec = await authUserOf(u);
  if (!rec) throw new HttpsError("not-found", "That account does not exist.");
  const until = permanent ? PERMANENT : Date.now() + minutes * 60000;
  const b = db.batch();
  if (prof.exists) b.update(prof.ref, { susp: until });
  b.set(db.collection("suspensions").doc(u), { until, reason, by: adm.name, t: Date.now() });
  await b.commit();
  await admin.auth().revokeRefreshTokens(rec.uid).catch(() => {});
  await logAdmin(adm.name, "suspend", u, { until, permanent, minutes: permanent ? 0 : minutes, reason }, adm.ip);
  await logSec("suspend", adm.name, u, { reason }, adm.ip);
  await send(u, { title: "Your account has been suspended", body: reason }, { type: "suspended" }, "updates", 24 * 3600 * 1000, "susp_" + u).catch(() => {});
  return { ok: true, until };
});

callable("adminUnsuspend", async (req) => {
  const adm = await requireAdmin(req);
  const u = cleanName(req.data && req.data.u);
  const prof = await db.collection("profiles").doc(u).get();
  const b = db.batch();
  if (prof.exists) b.update(prof.ref, { susp: admin.firestore.FieldValue.delete() });
  b.delete(db.collection("suspensions").doc(u));
  await b.commit();
  await logAdmin(adm.name, "unsuspend", u, {}, adm.ip);
  await logSec("unsuspend", adm.name, u, {}, adm.ip);
  return { ok: true };
});

async function wipe(ref) {
  try {
    await db.recursiveDelete(ref);
  } catch (e) {
    console.error("wipe failed", ref.path, e.message);
  }
}

callable("adminTerminate", async (req) => {
  const adm = await requireAdmin(req, ["owner", "admin"]);
  const u = cleanName(req.data && req.data.u);
  const reason = cleanReason(req.data && req.data.reason);
  if (String((req.data && req.data.confirm) || "").toLowerCase() !== u) throw new HttpsError("invalid-argument", "Type the username to confirm.");
  const rec = await authUserOf(u);
  const sum = { friends: 0, groupsRemoved: 0, groupsLeft: 0, chats: 0 };
  await db.collection("terminated").doc(u).set({ reason, by: adm.name, t: Date.now() });
  await logSec("terminate_start", adm.name, u, { reason }, adm.ip);

  const fr = await db.collection("friends").where("members", "array-contains", u).get();
  for (const f of fr.docs) {
    const chat = "dm_" + f.id;
    await wipe(db.collection("msgs").doc(chat));
    await wipe(db.collection("calls").doc(chat));
    await wipe(db.collection("rcpt").doc(chat));
    await f.ref.delete();
    sum.friends++;
    sum.chats++;
  }
  const gr = await db.collection("groups").where("members", "array-contains", u).get();
  for (const g of gr.docs) {
    if (g.get("owner") === u) {
      await wipe(db.collection("msgs").doc(g.id));
      await wipe(db.collection("calls").doc(g.id));
      await wipe(db.collection("rcpt").doc(g.id));
      await g.ref.delete();
      sum.groupsRemoved++;
    } else {
      await g.ref.update({
        members: admin.firestore.FieldValue.arrayRemove(u),
        pending: admin.firestore.FieldValue.arrayRemove(u),
      });
      sum.groupsLeft++;
    }
  }
  const del = async (q) => {
    const s = await q.get();
    await Promise.all(s.docs.map((d) => d.ref.delete()));
  };
  await del(db.collection("requests").where("from", "==", u));
  await del(db.collection("requests").where("to", "==", u));
  await del(db.collection("blocks").where("by", "==", u));
  await del(db.collection("blocks").where("u", "==", u));
  await del(db.collection("pings").where("to", "==", u));
  await Promise.all(
    ["profiles", "presence", "flists", "verified", "emailpending", "suspensions"].map((c) => db.collection(c).doc(u).delete().catch(() => {}))
  );
  if (rec) {
    await wipe(db.collection("users").doc(rec.uid));
    await admin.auth().revokeRefreshTokens(rec.uid).catch(() => {});
    await admin.auth().deleteUser(rec.uid).catch((e) => console.error("deleteUser", e.message));
  }
  await logAdmin(adm.name, "terminate", u, Object.assign({ reason }, sum), adm.ip);
  await logSec("terminate", adm.name, u, Object.assign({ reason }, sum), adm.ip);
  return Object.assign({ ok: true }, sum);
});

callable("adminImpersonate", async (req) => {
  const adm = await requireAdmin(req);
  const u = cleanName(req.data && req.data.u);
  const reason = cleanReason(req.data && req.data.reason, 5);
  const rec = await authUserOf(u);
  if (!rec) throw new HttpsError("not-found", "That account does not exist.");
  const term = await db.collection("terminated").doc(u).get();
  if (term.exists) throw new HttpsError("failed-precondition", "That account was terminated.");
  await logAdmin(adm.name, "impersonate_start", u, { reason }, adm.ip);
  await logSec("impersonate_start", adm.name, u, { reason }, adm.ip);
  try {
    const token = await admin.auth().createCustomToken(rec.uid, { imp: adm.name, email: u + "@grouphangout.app", email_verified: true });
    return { token };
  } catch (e) {
    await logSec("impersonate_failed", adm.name, u, { error: String(e.message).slice(0, 200) }, adm.ip);
    throw new HttpsError(
      "failed-precondition",
      "Could not create the sign-in token. Check that the FIREBASE_SERVICE_ACCOUNT key on the server is the full JSON from Firebase."
    );
  }
});

callable("impersonationEnd", async (req) => {
  const t = req.auth && req.auth.token;
  if (!t || !t.imp) throw new HttpsError("permission-denied", "Not an admin session.");
  const u = String(t.email || "").split("@")[0];
  await logAdmin(String(t.imp), "impersonate_end", u, {}, ipOf(req));
  await logSec("impersonate_end", String(t.imp), u, {}, ipOf(req));
  return { ok: true };
});

callable("adminLogs", async (req) => {
  const adm = await requireAdmin(req);
  const kind = req.data && req.data.kind === "security" ? "securityLogs" : "adminLogs";
  const before = Number(req.data && req.data.before) || 0;
  let q = db.collection(kind).orderBy("t", "desc");
  if (before) q = q.startAfter(before);
  const s = await q.limit(80).get();
  return { logs: s.docs.map((d) => d.data()) };
});

callable("adminList", async (req) => {
  await requireAdmin(req, ["owner"]);
  const s = await db.collection("admins").get();
  return { admins: s.docs.map((d) => ({ name: d.id, role: d.get("role"), disabled: !!d.get("disabled"), created: d.get("created") || 0, by: d.get("by") || "" })) };
});

callable("adminCreate", async (req) => {
  const adm = await requireAdmin(req, ["owner"]);
  const name = String((req.data && req.data.name) || "").toLowerCase().trim();
  const password = String((req.data && req.data.password) || "");
  const role = req.data && req.data.role === "owner" ? "owner" : "admin";
  if (!ADMIN_NAME_RE.test(name)) throw new HttpsError("invalid-argument", "Admin name: 3 to 20 letters, numbers or _.");
  if (password.length < 10) throw new HttpsError("invalid-argument", "Use a password of at least 10 characters.");
  const ref = db.collection("admins").doc(name);
  if ((await ref.get()).exists) throw new HttpsError("already-exists", "That admin already exists.");
  const h = hashPw(password);
  await ref.set({ role, salt: h.salt, hash: h.hash, sv: 0, disabled: false, created: Date.now(), by: adm.name });
  await logAdmin(adm.name, "admin_create", name, { role }, adm.ip);
  await logSec("admin_create", adm.name, name, { role }, adm.ip);
  return { ok: true };
});

callable("adminDisable", async (req) => {
  const adm = await requireAdmin(req, ["owner"]);
  const name = String((req.data && req.data.name) || "").toLowerCase().trim();
  const disabled = !!(req.data && req.data.disabled);
  if (name === adm.name) throw new HttpsError("failed-precondition", "You cannot disable yourself.");
  const ref = db.collection("admins").doc(name);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "No such admin.");
  await ref.update({ disabled, sv: admin.firestore.FieldValue.increment(1) });
  await logAdmin(adm.name, disabled ? "admin_disable" : "admin_enable", name, {}, adm.ip);
  await logSec(disabled ? "admin_disable" : "admin_enable", adm.name, name, {}, adm.ip);
  return { ok: true };
});

callable("adminPassword", async (req) => {
  const adm = await requireAdmin(req);
  const cur = String((req.data && req.data.current) || "");
  const next = String((req.data && req.data.next) || "");
  if (next.length < 10) throw new HttpsError("invalid-argument", "Use a password of at least 10 characters.");
  const ref = db.collection("admins").doc(adm.name);
  const d = await ref.get();
  const h = hashPw(cur, d.get("salt"));
  if (!safeEq(h.hash, d.get("hash"))) {
    await logSec("password_change_failed", adm.name, adm.name, {}, adm.ip);
    throw new HttpsError("permission-denied", "Your current password is wrong.");
  }
  const n = hashPw(next);
  await ref.update({ salt: n.salt, hash: n.hash, sv: admin.firestore.FieldValue.increment(1) });
  await logAdmin(adm.name, "password_change", adm.name, {}, adm.ip);
  await logSec("password_change", adm.name, adm.name, {}, adm.ip);
  return { ok: true };
});

startListeners();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server listening on", PORT));
