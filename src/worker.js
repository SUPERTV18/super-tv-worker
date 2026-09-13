const NEW_UA="stv2026";
const OLD_UA="2026stv";
const FALLBACK="https://github.com/himasabry/video/raw/refs/heads/main/output.m3u8";
const BROWSER_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const txt=(s,n=200,h={})=>new Response(s,{status:n,headers:{"Content-Type":"text/plain; charset=utf-8","Access-Control-Allow-Origin":"*",...h}});
const js=(o,n=200)=>new Response(JSON.stringify(o),{status:n,headers:{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*"}});
const red=u=>new Response(null,{status:302,headers:{Location:u,"Access-Control-Allow-Origin":"*"}});

async function channels(env,req){
  if(env.DATA_KV){const x=await env.DATA_KV.get("channels","json");if(x)return x;}
  const r=await env.ASSETS.fetch(new URL("/data/channels.json",req.url));
  if(!r.ok)throw Error("channels.json not found");
  return r.json();
}
async function saveAllowed(req,env){
  return !env.ADMIN_KEY || req.headers.get("X-Admin-Key")===env.ADMIN_KEY;
}
async function inc(env,id){
  if(!env.DATA_KV)return;
  const k=`viewer:${id}`, v=Number(await env.DATA_KV.get(k)||0);
  await env.DATA_KV.put(k,String(v+1),{expirationTtl:35});
}
async function play(req,env){
  const u=new URL(req.url),id=u.searchParams.get("id");
  if(!id)return txt("Missing id",400);
  const ua=(req.headers.get("User-Agent")||"").toLowerCase();
  await inc(env,id);
  if(ua.includes(OLD_UA)||ua.includes("superlivetv"))return red(FALLBACK);
  if(!ua.includes(NEW_UA))return txt("Forbidden",403);

  const data=await channels(env,req); let ch=null;
  for(const g of Object.values(data)){if(!Array.isArray(g))continue;const f=g.find(x=>String(x.id)===String(id));if(f){ch=f;break;}}
  if(!ch)return txt("Channel not found",404);
  if(!ch.url)return txt("Channel URL missing",404);
  if(!ch.url.toLowerCase().includes("ostora"))return red(ch.url);

  const clean=ch.url.split("#")[0];
  const r=await fetch(clean,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0",Referer:"https://ostora.pages.dev/"}});
  if(!r.ok)return txt(`Upstream error: ${r.status}`,r.status);
  return red(r.url);
}
async function channelsApi(req,env){
  if(req.method==="GET")return js(await channels(env,req));
  if(req.method!=="POST")return js({error:"Method not allowed"},405);
  if(!await saveAllowed(req,env))return js({error:"Unauthorized"},401);
  if(!env.DATA_KV)return js({error:"DATA_KV binding is required for saving channels"},500);
  await env.DATA_KV.put("channels",JSON.stringify(await req.json()));
  return js({status:"ok"});
}
async function viewers(req,env){
  const id=new URL(req.url).searchParams.get("id");
  if(!id)return js({error:"Missing id"},400);
  const n=env.DATA_KV?Number(await env.DATA_KV.get(`viewer:${id}`)||0):0;
  return js({[id]:n});
}
function proxyUrl(req,u){const x=new URL("/api/ts",req.url);x.searchParams.set("url",u);return x.pathname+"?"+x.searchParams.toString();}
async function proxy(req){
  const target=new URL(req.url).searchParams.get("url");
  if(!target)return txt("Missing url",400);
  try{
    const r=await fetch(target,{redirect:"follow",headers:{"User-Agent":BROWSER_UA}});
    const ct=r.headers.get("content-type")||"";
    if(ct.includes("mpegurl")||target.includes(".m3u8")){
      let b=await r.text();
      b=b.replace(/https?:\/\/[^\s"']+/g,u=>proxyUrl(req,u));
      return new Response(b,{status:r.status,headers:{"Content-Type":"application/vnd.apple.mpegurl","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"}});
    }
    return new Response(r.body,{status:r.status,headers:{"Content-Type":ct||"application/octet-stream","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"}});
  }catch(e){console.error(e);return txt("Proxy error",500);}
}
async function ts(req){
  const target=new URL(req.url).searchParams.get("url");
  if(!target)return txt("Missing url",400);
  try{
    const r=await fetch(target,{redirect:"follow",headers:{"User-Agent":BROWSER_UA}});
    return new Response(r.body,{status:r.status,headers:{"Content-Type":r.headers.get("content-type")||"video/mp2t","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"}});
  }catch(e){return txt("TS Proxy Error",500);}
}
async function playlist(req,env){
  const data=await channels(env,req),base=new URL(req.url).origin;let m="#EXTM3U\n";
  for(const g in data)for(const c of (Array.isArray(data[g])?data[g]:[])){
    m+=`#EXTINF:-1 tvg-id="${c.id}" group-title="${g}",${c.name}\n${base}/api/play.m3u8?id=${encodeURIComponent(c.id)}\n`;
  }
  return new Response(m,{headers:{"Content-Type":"application/x-mpegURL; charset=utf-8","Content-Disposition":'attachment; filename="SuperTV.m3u"',"Access-Control-Allow-Origin":"*"}});
}
export default {async fetch(req,env){
  try{
    const p=new URL(req.url).pathname;
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,X-Admin-Key"}});
    if(p==="/api/play.m3u8")return play(req,env);
    if(p==="/api/channels"||p==="/api/save")return channelsApi(req,env);
    if(p==="/api/viewers")return viewers(req,env);
    if(p==="/api/playlist.m3u")return playlist(req,env);
    if(p==="/api/proxy.m3u8")return proxy(req);
    if(p==="/api/ts")return ts(req);
    if(p==="/admin"||p==="/admin/")return env.ASSETS.fetch(new URL("/admin.html",req.url));
    return env.ASSETS.fetch(req);
  }catch(e){console.error(e);return txt("Server error: "+(e?.message||"Unknown error"),500);}
}};
