// =====================================================================
// SUPER LIVE TV — إضافات الـ Worker للوحة الإدارة (admin-v3.html)
// =====================================================================
// هذا الملف دوال جاهزة تُدمج في الـ Worker الحالي، وليس بديلًا عنه.
//
// ما يغطيه:
//   1) المشاهدون الآن + IP + الدولة + الشبكة  (Durable Object: ViewerTracker)
//   2) كشف التعارض عند الحفظ (X-File-Sha / X-Base-Sha) + منع الكتابة فوق تعديلات جهاز آخر
//   3) سجل التعديلات واسترجاع أي نسخة من GitHub
//   4) فحص مجدول + تنبيه تيليجرام عند سقوط/رجوع قناة (اختياري)
//   5) تجاهل القنوات الموقوفة (enabled:false)
//
// ---------------------------------------------------------------------
// الخطوة 1 — wrangler.toml (أضف هذه الأقسام)
// ---------------------------------------------------------------------
//   [[durable_objects.bindings]]
//   name = "TRACKER"
//   class_name = "ViewerTracker"
//
//   [[migrations]]
//   tag = "v1"
//   new_sqlite_classes = ["ViewerTracker"]     # SQLite-backed يعمل على الخطة المجانية
//
//   [triggers]
//   crons = ["*/15 * * * *"]                   # اختياري: الفحص المجدول
//
// Secrets اختيارية للتنبيهات:  TELEGRAM_BOT_TOKEN  و  TELEGRAM_CHAT_ID
//
// ---------------------------------------------------------------------
// الخطوة 2 — الدمج في ملف الـ Worker الرئيسي (5 تعديلات صغيرة)
// ---------------------------------------------------------------------
//  (أ) صدّر الكلاس من نقطة الدخول:   export { ViewerTracker } from "./worker-additions.mjs";
//  (ب) داخل fetch() بعد فحص X-Admin-Key مباشرة أضف:
//        const adminRes = await routeAdminExtras(request, env);  if (adminRes) return adminRes;
//      (ويجب أن يأتي قبل مسارات /api/admin/channels القديمة لو كنت ستستبدلها بـ handleChannelsGet/Post)
//  (ج) في مسارات التشغيل play.m3u8 و play.flv بعد معرفة القناة:
//        trackView(request, env, ctx, {id, name, group});
//      وفي مسار FLV الطويل استبدل الرد بـ:   return trackStream(request, env, ctx, ch, response);
//  (د) تجاهل الموقوفة: في مسارات التشغيل أرجع 404 لو  ch.enabled === false،
//      وفي endpoint الذي يقرأه التطبيق صفّ القنوات:  list.filter(c => c.enabled !== false)
//  (هـ) للفحص المجدول، في export default أضف:
//        async scheduled(event, env, ctx) { ctx.waitUntil(scheduledCheck(env)); }
//
// ملاحظة: بعد أي كتابة ناجحة على GitHub استدعِ نفس دالة تفريغ الكاش المستخدمة عندك حاليًا.
// =====================================================================

const GH = { owner: "SUPERTV18", repo: "super-tv-worker", path: "public/data/channels.json" };
const SESSION_TTL_MS = 90_000;      // الجلسة تعتبر نشطة إن كان آخر نشاط خلال 90 ثانية
const BEAT_THROTTLE_MS = 10_000;    // أقل فاصل بين نبضتين لنفس (IP + قناة) داخل نفس النسخة

const J = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

// ---------------------------------------------------------------------
// 1) تتبّع المشاهدين  —  Durable Object واحد، الذاكرة فقط، بدون تخزين دائم لأي IP
// ---------------------------------------------------------------------
export class ViewerTracker {
  constructor(state) {
    this.state = state;
    this.sessions = new Map();
  }
  prune(now) {
    for (const [k, s] of this.sessions) if (now - s.lastSeen > SESSION_TTL_MS) this.sessions.delete(k);
  }
  key(b) { return b.ip + "|" + b.ch + "|" + String(b.ua || "").slice(0, 40); }
  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === "/beat" && request.method === "POST") {
      const b = await request.json();
      if (!b || !b.ip || !b.ch) return new Response("bad", { status: 400 });
      const k = this.key(b), s = this.sessions.get(k);
      if (s) s.lastSeen = now;
      else this.sessions.set(k, { ...b, firstSeen: now, lastSeen: now });
      this.prune(now);
      return new Response("ok");
    }
    if (url.pathname === "/bye" && request.method === "POST") {
      const b = await request.json();
      this.sessions.delete(this.key(b));
      return new Response("ok");
    }
    if (url.pathname === "/list") {
      this.prune(now);
      return J({ viewers: [...this.sessions.values()], serverTime: now, ttlSeconds: SESSION_TTL_MS / 1000 });
    }
    // حالة الفحص المجدول (تخزين خفيف داخل الـ DO نفسه، بدون KV)
    if (url.pathname === "/health-get") return J((await this.state.storage.get("health")) || {});
    if (url.pathname === "/health-put" && request.method === "POST") {
      await this.state.storage.put("health", await request.json());
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }
}

const lastBeat = new Map(); // تخفيف الضغط على الـ DO (لكل نسخة Worker)

function trackerStub(env) { return env.TRACKER.get(env.TRACKER.idFromName("global")); }

function viewerPayload(request, ch) {
  const cf = request.cf || {};
  return {
    ip: request.headers.get("CF-Connecting-IP") || "",
    ch: String(ch.id),
    name: String(ch.name || ch.id),
    group: String(ch.group || ch.__group || ""),
    country: cf.country || "",
    city: cf.city || "",
    org: cf.asOrganization || "",
    ua: (request.headers.get("User-Agent") || "").slice(0, 160),
  };
}

/** نبضة مشاهدة (للـ HLS: تُستدعى مع كل طلب playlist). لا تؤخّر الرد ولا تكسره أبدًا. */
export function trackView(request, env, ctx, ch) {
  try {
    if (!env.TRACKER) return;
    const p = viewerPayload(request, ch);
    if (!p.ip) return;
    const k = p.ip + "|" + p.ch, now = Date.now();
    if (now - (lastBeat.get(k) || 0) < BEAT_THROTTLE_MS) return;
    lastBeat.set(k, now);
    if (lastBeat.size > 5000) for (const [kk, t] of lastBeat) if (now - t > 60_000) lastBeat.delete(kk);
    ctx.waitUntil(trackerStub(env).fetch("https://tracker/beat", { method: "POST", body: JSON.stringify(p) }).catch(() => {}));
  } catch (_) { /* التتبع اختياري */ }
}

/**
 * اختياري لمسار FLV الطويل: يرسل نبضة كل 30 ثانية طالما الاتصال مفتوح، ويحذف الجلسة عند الإغلاق.
 * يمرّر البيانات كما هي عبر TransformStream؛ جرّبه على قناة واحدة أولًا.
 */
export function trackStream(request, env, ctx, ch, response) {
  try {
    if (!env.TRACKER || !response.body) { trackView(request, env, ctx, ch); return response; }
    const p = viewerPayload(request, ch);
    const stub = trackerStub(env);
    const beat = () => stub.fetch("https://tracker/beat", { method: "POST", body: JSON.stringify(p) }).catch(() => {});
    beat();
    const timer = setInterval(beat, 30_000);
    const { readable, writable } = new TransformStream();
    ctx.waitUntil(
      response.body.pipeTo(writable).catch(() => {}).finally(() => {
        clearInterval(timer);
        stub.fetch("https://tracker/bye", { method: "POST", body: JSON.stringify(p) }).catch(() => {});
      })
    );
    return new Response(readable, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (_) {
    return response;
  }
}

// ---------------------------------------------------------------------
// 2) GitHub: قراءة/كتابة channels.json مع sha
// ---------------------------------------------------------------------
function gh(env, path, init = {}) {
  return fetch("https://api.github.com/repos/" + GH.owner + "/" + GH.repo + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "super-tv-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}
export function b64decodeUtf8(s) {
  const bin = atob(String(s).replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
export function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function getChannelsFile(env, ref) {
  const r = await gh(env, "/contents/" + GH.path + (ref ? "?ref=" + encodeURIComponent(ref) : ""));
  if (!r.ok) { const e = new Error("GitHub " + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(b64decodeUtf8(j.content)) };
}
async function putChannelsFile(env, data, sha, message) {
  const r = await gh(env, "/contents/" + GH.path, {
    method: "PUT",
    body: JSON.stringify({ message, content: b64encodeUtf8(JSON.stringify(data, null, 2) + "\n"), sha }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || "GitHub " + r.status); e.status = r.status; throw e; }
  return j.content.sha;
}
export function validateChannels(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "صيغة غير صحيحة";
  const seen = new Set();
  for (const [g, arr] of Object.entries(data)) {
    if (!Array.isArray(arr)) return "المجموعة " + g + " ليست قائمة";
    for (const c of arr) {
      const id = String(c && c.id != null ? c.id : "").trim();
      if (!id || !c.name || !/^https?:\/\//i.test(String(c.url || ""))) return "قناة غير صالحة في " + g;
      if (seen.has(id)) return "ID مكرر: " + id;
      seen.add(id);
    }
  }
  return "";
}

/** بدائل/ترقيات لمسارَي القنوات: GET يرجّع sha في الهيدر، POST يرفض (409) إن كان الملف تغيّر. */
export async function handleChannelsGet(env) {
  const f = await getChannelsFile(env);
  return J(f.data, 200, { "X-File-Sha": f.sha });
}
export async function handleChannelsPost(request, env) {
  const base = request.headers.get("X-Base-Sha") || "";
  const data = await request.json();
  const bad = validateChannels(data);
  if (bad) return J({ error: bad }, 400);
  const cur = await getChannelsFile(env);
  if (base && base !== cur.sha) return J({ error: "الملف تغيّر من مكان آخر. حمّل أحدث نسخة أولًا." }, 409);
  try {
    const sha = await putChannelsFile(env, data, cur.sha, "Update channels from admin panel");
    return J({ ok: true, message: "تم حفظ القناة في GitHub", sha });
  } catch (e) {
    return J({ error: e.message }, e.status === 409 || e.status === 422 ? 409 : 502);
  }
}

// ---------------------------------------------------------------------
// 3) سجل التعديلات والاسترجاع
// ---------------------------------------------------------------------
export async function handleHistory(request, env) {
  const u = new URL(request.url);
  const sha = u.searchParams.get("sha");
  if (sha) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return J({ error: "sha غير صالح" }, 400);
    const f = await getChannelsFile(env, sha);
    return J({ channels: f.data, sha });
  }
  const r = await gh(env, "/commits?path=" + encodeURIComponent(GH.path) + "&per_page=25");
  if (!r.ok) return J({ error: "GitHub " + r.status }, 502);
  const list = await r.json();
  return J({
    commits: list.map((c) => ({
      sha: c.sha,
      message: String((c.commit && c.commit.message) || "").split("\n")[0],
      date: c.commit && c.commit.author && c.commit.author.date,
      author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || "",
    })),
  });
}
export async function handleRestore(request, env) {
  const { sha } = await request.json().catch(() => ({}));
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ""))) return J({ error: "sha غير صالح" }, 400);
  const old = await getChannelsFile(env, sha);
  const bad = validateChannels(old.data);
  if (bad) return J({ error: "النسخة المختارة غير صالحة: " + bad }, 400);
  const cur = await getChannelsFile(env);
  try {
    const newSha = await putChannelsFile(env, old.data, cur.sha, "Restore channels.json from " + String(sha).slice(0, 7));
    return J({ ok: true, message: "تم استرجاع النسخة " + String(sha).slice(0, 7), sha: newSha });
  } catch (e) {
    return J({ error: e.message }, e.status === 409 || e.status === 422 ? 409 : 502);
  }
}

// ---------------------------------------------------------------------
// المشاهدون
// ---------------------------------------------------------------------
export async function handleViewers(env) {
  if (!env.TRACKER) return J({ error: "Durable Object TRACKER غير مضاف" }, 404);
  const r = await trackerStub(env).fetch("https://tracker/list");
  return new Response(r.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

/** موجّه واحد للمسارات الجديدة. يُرجع null إن لم يطابق المسار. استدعه بعد التحقق من X-Admin-Key. */
export async function routeAdminExtras(request, env) {
  const p = new URL(request.url).pathname;
  try {
    if (p === "/api/admin/viewers" && request.method === "GET") return await handleViewers(env);
    if (p === "/api/admin/history" && request.method === "GET") return await handleHistory(request, env);
    if (p === "/api/admin/restore" && request.method === "POST") return await handleRestore(request, env);
  } catch (e) {
    return J({ error: e.message || "خطأ" }, 502);
  }
  return null;
}

// ---------------------------------------------------------------------
// 4) الفحص المجدول + تيليجرام
// ---------------------------------------------------------------------
async function probe(ch) {
  const h = {}, H = ch.headers || {};
  if (H["User-Agent"]) h["User-Agent"] = H["User-Agent"];
  if (H.Referer) h.Referer = H.Referer;
  if (H.Origin) h.Origin = H.Origin;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(ch.url, { headers: h, signal: ac.signal, redirect: "follow" });
    try { r.body && r.body.cancel(); } catch (_) {}
    return r.status >= 200 && r.status < 400;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(t);
  }
}
async function telegram(env, text) {
  await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  }).catch(() => {});
}

/**
 * يفحص دفعة دوّارة من القنوات المفعّلة في كل تشغيل (حد الـ subrequests: 50 في الخطة المجانية).
 * غيّر CRON_MAX_CHECKS كمتغير لو خطتك المدفوعة. الأفضل لاحقًا استبدال probe بنفس دالة
 * /api/admin/check-channels الموجودة عندك ليكون التشخيص مطابقًا.
 */
export async function scheduledCheck(env) {
  if (!env.TRACKER) return;
  const stub = trackerStub(env);
  const prev = await (await stub.fetch("https://tracker/health-get")).json();
  const { data } = await getChannelsFile(env);
  const all = Object.entries(data).flatMap(([g, a]) => (a || []).filter((c) => c.enabled !== false).map((c) => ({ ...c, group: g })));
  if (!all.length) return;
  const MAX = Math.max(1, Number(env.CRON_MAX_CHECKS || 30));
  const start = (prev.cursor || 0) % all.length;
  const batch = [];
  for (let i = 0; i < Math.min(MAX, all.length); i++) batch.push(all[(start + i) % all.length]);
  const results = { ...(prev.results || {}) };
  const down = [], back = [];
  for (let i = 0; i < batch.length; i += 8) {
    await Promise.all(batch.slice(i, i + 8).map(async (ch) => {
      const ok = await probe(ch);
      const was = results[ch.id] && results[ch.id].ok;
      results[ch.id] = { ok, t: Date.now() };
      if (!ok && was !== false) down.push(ch);
      if (ok && was === false) back.push(ch);
    }));
  }
  await stub.fetch("https://tracker/health-put", { method: "POST", body: JSON.stringify({ results, cursor: start + batch.length }) });
  if ((down.length || back.length) && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const lines = [];
    if (down.length) lines.push("⚠️ قنوات لا تستجيب (" + down.length + "):", ...down.slice(0, 20).map((c) => "• " + c.name + " (" + c.id + ")"));
    if (back.length) lines.push("✅ عادت للعمل (" + back.length + "):", ...back.slice(0, 20).map((c) => "• " + c.name + " (" + c.id + ")"));
    await telegram(env, "SUPER LIVE TV\n" + lines.join("\n"));
  }
}
