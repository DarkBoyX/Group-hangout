const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Must match your Firestore location. us-central1 works for the default "nam5" setup.
const REGION = "us-central1";

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

// Mark a message as "delivered" (2 gray ticks) for one person. Only ever moves forward.
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

// Someone @mentioned you in a group or private chat
exports.onPing = onDocumentCreated({ document: "pings/{id}", region: REGION }, async (event) => {
  const p = event.data.data();
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
});

// Every new message: notify the other people in the chat, even when the app is closed.
// People who were @mentioned already get the "pinged you" notification above, so skip them here.
exports.onMessage = onDocumentCreated({ document: "msgs/{chat}/items/{msg}", region: REGION }, async (event) => {
  const chat = event.params.chat;
  const m = event.data.data();
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
  // Call log entries: only push the missed ones (the ring itself already notified people)
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
});

// Both the call document and the call ping can ring someone. This makes sure each person is only rung once.
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

// Someone starts a call: ring the other person
const fresh = (c) => {
  const now = Date.now();
  return Object.entries((c && c.p) || {})
    .filter(([, v]) => v && v.toMillis && now - v.toMillis() < 60000)
    .map(([k]) => k);
};

exports.onCall = onDocumentWritten({ document: "calls/{id}", region: REGION }, async (event) => {
  const id = event.params.id;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
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
});
