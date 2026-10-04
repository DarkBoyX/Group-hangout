const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Must match your Firestore location. us-central1 works for the default "nam5" setup.
const REGION = "us-central1";

async function send(username, notification, data, channelId, ttl) {
  const snap = await db.collection("users").where("username", "==", username).limit(1).get();
  if (snap.empty) return;
  const ref = snap.docs[0].ref;
  const token = snap.docs[0].get("fcm");
  if (!token) return;
  try {
    await admin.messaging().send({
      token,
      notification,
      data,
      android: {
        priority: "high",
        ttl,
        notification: { channelId, sound: "default", defaultVibrateTimings: true },
      },
    });
  } catch (e) {
    if (e.code === "messaging/registration-token-not-registered") {
      await ref.update({ fcm: admin.firestore.FieldValue.delete() }).catch(() => {});
    }
  }
}

// Someone @mentioned you in a group
exports.onPing = onDocumentCreated({ document: "pings/{id}", region: REGION }, async (event) => {
  const p = event.data.data();
  await send(
    p.to,
    { title: `${p.from} pinged you in ${p.title}`, body: p.text || "" },
    { type: "ping", chat: p.chat, title: p.title },
    "pings",
    3600 * 1000
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
  if (!id.startsWith("dm_")) return;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;
  if (fresh(before).length) return; // call already active
  const now = fresh(after);
  if (!now.length) return;
  const caller = now[0];
  const targets = (after.invited || []).filter((u) => u !== caller);
  await Promise.all(
    targets.map((u) =>
      send(u, { title: `${caller} is calling`, body: "Tap to answer" }, { type: "call", chat: id, title: caller }, "calls", 30000)
    )
  );
});
