const C="group-hangout-v4";
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
