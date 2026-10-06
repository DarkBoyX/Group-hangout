importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js","https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
try{firebase.initializeApp({apiKey:"AIzaSyCEas-hEPy9j1xIDexxLI_JXZJVgI3Z-SU",authDomain:"group-24984.firebaseapp.com",projectId:"group-24984",appId:"1:674832131315:web:d98d9a0ca2bace4090c386",messagingSenderId:"674832131315"});firebase.messaging()}catch(e){}
self.addEventListener("notificationclick",e=>{
e.notification.close();
e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(l=>{for(const c of l){if("focus" in c)return c.focus()}return clients.openWindow("./")}));
});
const C="group-hangout-v14";
const FB=["https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js","https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js","https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"];
self.addEventListener("install",e=>{
e.waitUntil(caches.open(C).then(async c=>{
await c.addAll(["./","index.html"]);
await Promise.all(["offline.html","manifest.json","icon.svg","icon-192.png","icon-512.png"].map(u=>c.add(u).catch(()=>{})));
await Promise.all(FB.map(u=>fetch(u,{mode:"no-cors"}).then(r=>c.put(u,r)).catch(()=>{})));
}));
self.skipWaiting();
});
self.addEventListener("activate",e=>{
e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch",e=>{
const r=e.request;
if(r.method!=="GET")return;
const u=new URL(r.url);
if(u.origin!==location.origin&&u.hostname!=="www.gstatic.com")return;
if(r.mode==="navigate"){
e.respondWith(caches.match("index.html").then(hit=>{
const net=fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(C).then(c=>c.put("index.html",cp))}return res}).catch(()=>hit||caches.match("./")||caches.match("offline.html"));
return hit||net;
}));
return;
}
e.respondWith(caches.match(r).then(hit=>{
const net=fetch(r).then(res=>{
if(res.ok||res.type==="opaque"){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp))}
return res;
}).catch(()=>hit);
return hit||net;
}));
});

/* ---- background sync: tell open windows to flush anything queued while offline ---- */
self.addEventListener("sync",e=>{
if(e.tag==="sync-messages")e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(l=>l.forEach(c=>c.postMessage({type:"sync"}))));
});
/* ---- periodic sync: keep the cached app fresh ---- */
self.addEventListener("periodicsync",e=>{
if(e.tag==="refresh-app")e.waitUntil(caches.open(C).then(c=>c.add("index.html")).catch(()=>{}));
});
/* ---- push: Firebase (above) already shows its own notifications, this only covers plain web-push payloads ---- */
self.addEventListener("push",e=>{
let d=null;try{d=e.data&&e.data.json()}catch(x){}
if(!d||d.notification||d.fcmMessageId||d.from||d.data||!d.title)return;
e.waitUntil(self.registration.showNotification(d.title,{body:d.body||"",icon:"icon-192.png",badge:"icon-192.png",tag:d.tag||"hangout"}));
});
/* ---- Windows widget ---- */
async function paintWidget(w){
try{
if(!self.widgets||!w||!w.definition)return;
const t=await(await fetch(w.definition.msAcTemplate)).text();
const d=await(await fetch(w.definition.data)).text();
await self.widgets.updateByTag(w.definition.tag,{template:t,data:d});
}catch(x){}
}
self.addEventListener("widgetinstall",e=>e.waitUntil(paintWidget(e.widget)));
self.addEventListener("widgetresume",e=>e.waitUntil(paintWidget(e.widget)));
self.addEventListener("widgetclick",e=>{if(e.action==="open")e.waitUntil(clients.openWindow("./?tab=chats"))});
self.addEventListener("widgetuninstall",()=>{});
