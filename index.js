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
  if (snap.empty) return;
  const ref = snap.docs[0].ref;
  const token = snap.docs[0].get("fcm");
  if (!token) {
    console.log("no push token for", username);
    return;
  }
  try {
    await admin.messaging().send({
      token,
      notification,
      data,
      android: {
        priority: "high",
        ttl,
        notification: Object.assign(
          { channelId, sound: "default", defaultVibrateTimings: true, visibility: "public", notificationPriority: "PRIORITY_MAX" },
          tag ? { tag } : {}
        ),
      },
    });
  } catch (e) {
    console.error("push failed for", username, e.code || e.message);
    if (DEAD_TOKEN.includes(e.code)) {
      await ref.update({ fcm: admin.firestore.FieldValue.delete() }).catch(() => {});
    }
  }
}

// Someone @mentioned you in a group or private chat
exports.onPing = onDocumentCreated({ document: "pings/{id}", region: REGION }, async (event) => {
  const p = event.data.data();
  await send(
    p.to,
    { title: p.chat.startsWith("dm_") ? `${p.from} pinged you` : `${p.from} pinged you in ${p.title}`, body: p.text || "" },
    { type: "ping", chat: p.chat, title: p.title },
    "pings",
    3600 * 1000,
    "ping_" + p.chat
  );
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
  const body = m.text
    ? String(m.text).slice(0, 140)
    : m.voice
    ? "Voice message"
    : m.img
    ? "Photo"
    : m.file
    ? "File: " + (m.fname || "")
    : "New message";
  await Promise.all(
    targets.map((u) => send(u, { title, body }, { type: "msg", chat, title: chatName }, "messages", 3600 * 1000, "msg_" + chat))
  );
});

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
    targets.map((u) => send(u, { title: head, body }, { type: "call", chat: id, title }, "calls", 30000, "call_" + id))
  );
});
