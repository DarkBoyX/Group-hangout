importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js","https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
try{firebase.initializeApp({apiKey:"AIzaSyCEas-hEPy9j1xIDexxLI_JXZJVgI3Z-SU",authDomain:"group-24984.firebaseapp.com",projectId:"group-24984",appId:"1:674832131315:web:d98d9a0ca2bace4090c386",messagingSenderId:"674832131315"});firebase.messaging()}catch(e){}
self.addEventListener("notificationclick",e=>{
e.notification.close();
e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(l=>{for(const c of l){if("focus" in c)return c.focus()}return clients.openWindow("./")}));
});
const C="group-hangout-v11";
self.addEventListener("install",e=>{
e.waitUntil(caches.open(C).then(c=>c.addAll(["./","index.html","manifest.json","icon.svg","icon-192.png","icon-512.png"])));
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
e.respondWith(caches.match(r).then(hit=>{
const net=fetch(r).then(res=>{
if(res.ok||res.type==="opaque"){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp))}
return res;
}).catch(()=>hit);
return hit||net;
}));
});
