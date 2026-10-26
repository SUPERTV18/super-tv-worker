// ============================================================
// SUPER TV API - Cloudflare Worker
// HLS SOURCE HIDDEN PROXY
// GITHUB CHANNELS + CLOUDFLARE CACHE
// KV OPTIMIZED VERSION
// ============================================================

const DEFAULT_NEW_UA = "stv2026";
const DEFAULT_OLD_UA = "2026stv";
const DEFAULT_PROXY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const SERVER_SETTINGS_URL = "https://raw.githubusercontent.com/SUPERTV18/super-tv-worker/main/public/data/server-settings.json";
let SERVER_UA_SETTINGS_CACHE = null;
let SERVER_UA_SETTINGS_CACHE_TIME = 0;
const SERVER_UA_SETTINGS_TTL = 30 * 1000;

async function getServerUASettings() {
  const now = Date.now();
  if (SERVER_UA_SETTINGS_CACHE && now - SERVER_UA_SETTINGS_CACHE_TIME < SERVER_UA_SETTINGS_TTL) {
    return SERVER_UA_SETTINGS_CACHE;
  }
  try {
    const response = await fetch(SERVER_SETTINGS_URL, {
      headers: { "Accept": "application/json", "User-Agent": "SUPER-TV-Worker" },
      cf: { cacheTtl: 30, cacheEverything: true }
    });
    if (response.ok) {
      const data = await response.json();
      if (data && typeof data.newUA === "string" && typeof data.oldUA === "string" && typeof data.proxyUA === "string") {
        SERVER_UA_SETTINGS_CACHE = {
          newUA: data.newUA.trim() || DEFAULT_NEW_UA,
          oldUA: data.oldUA.trim() || DEFAULT_OLD_UA,
          proxyUA: data.proxyUA.trim() || DEFAULT_PROXY_UA
        };
        SERVER_UA_SETTINGS_CACHE_TIME = now;
        return SERVER_UA_SETTINGS_CACHE;
      }
    }
  } catch (e) {
    console.error("SERVER UA SETTINGS LOAD ERROR", e.message);
  }
  return { newUA: DEFAULT_NEW_UA, oldUA: DEFAULT_OLD_UA, proxyUA: DEFAULT_PROXY_UA };
}

async function saveServerUASettings(env, newUA, oldUA, proxyUA) {
  if (!env.GITHUB_TOKEN) throw new Error("يجب ضبط GITHUB_TOKEN في إعدادات Worker.");
  const apiUrl = "https://api.github.com/repos/SUPERTV18/super-tv-worker/contents/public/data/server-settings.json";
  const headers = {
    "Authorization": "Bearer " + env.GITHUB_TOKEN,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "SUPER-TV-Admin"
  };
  const currentResponse = await fetch(apiUrl, { headers });
  let current = null;
  if (currentResponse.status === 404) {
    current = null;
  } else {
    if (!currentResponse.ok) throw new Error("تعذر قراءة إعدادات السيرفر من GitHub: " + currentResponse.status);
    current = await currentResponse.json();
  }
  const content = JSON.stringify({ newUA, oldUA, proxyUA }, null, 2);
  const encoded = btoa(Array.from(new TextEncoder().encode(content), b => String.fromCharCode(b)).join(""));
  const body = {
    message: "Update server User-Agent settings",
    content: encoded,
    branch: "main"
  };
  if (current?.sha) body.sha = current.sha;
  const response = await fetch(apiUrl, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || ("GitHub save failed: " + response.status));
  SERVER_UA_SETTINGS_CACHE = { newUA, oldUA, proxyUA };
  SERVER_UA_SETTINGS_CACHE_TIME = Date.now();
  try { await caches.default.delete(new Request(SERVER_SETTINGS_URL)); } catch {}
  return { status: "ok", settings: SERVER_UA_SETTINGS_CACHE };
}

const FALLBACK_VIDEO =
  "https://github.com/himasabry/video/raw/refs/heads/main/master.m3u8";

const PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

// ============================================================
// GITHUB CHANNELS SOURCE
// ============================================================

const CHANNELS_GITHUB_URL =
  "https://raw.githubusercontent.com/SUPERTV18/super-tv-worker/main/public/data/channels.json";

// مدة Cloudflare Cache
const CHANNELS_CACHE_TTL = 10;

// مدة Memory Cache
const CHANNELS_MEMORY_TTL = 10 * 1000;

// ============================================================
// RATE LIMIT
// ============================================================

const PLAY_RATE_LIMIT = 30;
const PLAY_RATE_WINDOW = 60;

const INVALID_RATE_LIMIT = 15;
const INVALID_RATE_WINDOW = 60;

// ============================================================
// HLS TOKEN
// ============================================================

const HLS_TOKEN_TTL = 30 * 60 * 1000;

// ============================================================
// CHANNEL MEMORY CACHE
// ============================================================

let CHANNELS_MEMORY_CACHE = null;
let CHANNELS_MEMORY_CACHE_TIME = 0;

// ============================================================
// MEMORY RATE LIMIT
// ============================================================

const RATE_LIMIT_MEMORY = new Map();

// ============================================================
// MEMORY VIEWERS
// ============================================================

const VIEWERS_MEMORY = new Map();

// Recent diagnostic events are isolate-memory only: no KV writes.
const ADMIN_EVENT_LOGS = [];
const ADMIN_EVENT_LOG_LIMIT = 150;
function recordAdminEvent(event) {
  ADMIN_EVENT_LOGS.unshift({ time: new Date().toISOString(), ...event });
  if (ADMIN_EVENT_LOGS.length > ADMIN_EVENT_LOG_LIMIT) ADMIN_EVENT_LOGS.length = ADMIN_EVENT_LOG_LIMIT;
}

// ============================================================
// RESPONSE HELPERS
// ============================================================

function json(data, status = 200) {

  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Access-Control-Allow-Origin":
          "*",

        "Cache-Control":
          "no-store"
      }
    }
  );

}

function text(
  body,
  status = 200,
  contentType = "text/plain; charset=utf-8"
) {

  return new Response(
    body,
    {
      status,

      headers: {
        "Content-Type":
          contentType,

        "Access-Control-Allow-Origin":
          "*",

        "Cache-Control":
          "no-store"
      }
    }
  );

}

// ============================================================
// GET CLIENT IP
// ============================================================

function getClientIP(request) {

  return (
    request.headers.get(
      "CF-Connecting-IP"
    ) ||
    request.headers.get(
      "X-Forwarded-For"
    ) ||
    "unknown"
  )
  .split(",")[0]
  .trim();

}

// ============================================================
// SHA256
// ============================================================

async function sha256(value) {

  const data =
    new TextEncoder().encode(
      value
    );

  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return Array.from(
    new Uint8Array(hash)
  )
  .map(
    b =>
      b
        .toString(16)
        .padStart(2, "0")
  )
  .join("");

}

// ============================================================
// BASE64URL ENCODE
// ============================================================

function base64UrlEncode(bytes) {

  let binary = "";

  for (
    const byte
    of bytes
  ) {

    binary +=
      String.fromCharCode(
        byte
      );

  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

}

// ============================================================
// BASE64URL DECODE
// ============================================================

function base64UrlDecode(value) {

  value =
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  while (
    value.length % 4
  ) {

    value += "=";

  }

  const binary =
    atob(value);

  const bytes =
    new Uint8Array(
      binary.length
    );

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {

    bytes[i] =
      binary.charCodeAt(i);

  }

  return bytes;

}

// ============================================================
// HMAC KEY
// ============================================================

async function getCryptoKey(env) {

  if (!env.APP_SECRET) {

    throw new Error(
      "APP_SECRET is not configured"
    );

  }

  return crypto.subtle.importKey(
    "raw",

    new TextEncoder().encode(
      env.APP_SECRET
    ),

    {
      name: "HMAC",
      hash: "SHA-256"
    },

    false,

    [
      "sign",
      "verify"
    ]
  );

}

// ============================================================
// CREATE HLS TOKEN
// ============================================================

async function createHLSToken(
  env,
  target,
  channelHeaders = {}
) {

  const expires =
    Date.now() +
    HLS_TOKEN_TTL;

  const payload =
    JSON.stringify({
      u: target,
      e: expires,
      h:
        normalizeChannelHeaders(
          channelHeaders
        )
    });

  const payloadBytes =
    new TextEncoder().encode(
      payload
    );

  const payload64 =
    base64UrlEncode(
      payloadBytes
    );

  const key =
    await getCryptoKey(
      env
    );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        payload64
      )
    );

  const sig64 =
    base64UrlEncode(
      new Uint8Array(
        signature
      )
    );

  return (
    `${payload64}.${sig64}`
  );

}

// ============================================================
// VERIFY HLS TOKEN
// ============================================================

async function verifyHLSToken(
  env,
  token
) {

  try {

    if (!token) {
      return null;
    }

    const parts =
      token.split(".");

    if (
      parts.length !== 2
    ) {
      return null;
    }

    const [
      payload64,
      sig64
    ] = parts;

    const key =
      await getCryptoKey(
        env
      );

    const valid =
      await crypto.subtle.verify(
        "HMAC",
        key,
        base64UrlDecode(
          sig64
        ),
        new TextEncoder().encode(
          payload64
        )
      );

    if (!valid) {
      return null;
    }

    const payload =
      JSON.parse(
        new TextDecoder().decode(
          base64UrlDecode(
            payload64
          )
        )
      );

    if (
      !payload ||
      !payload.u ||
      !payload.e
    ) {

      return null;

    }

    if (
      Date.now() >
      Number(payload.e)
    ) {

      return null;

    }

    return {

      url:
        payload.u,

      expires:
        payload.e,

      headers:
        normalizeChannelHeaders(
          payload.h
        )

    };

  } catch (e) {

    console.error(
      "TOKEN VERIFY ERROR:",
      e
    );

    return null;

  }

}

// ============================================================
// MEMORY RATE LIMIT
// ============================================================

async function checkRateLimit(
  env,
  key,
  limit,
  windowSeconds
) {

  const now =
    Date.now();

  const storageKey =
    String(key);

  const old =
    RATE_LIMIT_MEMORY.get(
      storageKey
    );

  if (
    !old ||
    !old.resetAt ||
    old.resetAt <= now
  ) {

    RATE_LIMIT_MEMORY.set(
      storageKey,
      {
        count: 1,

        resetAt:
          now +
          windowSeconds * 1000
      }
    );

    return {

      allowed: true,

      remaining:
        Math.max(
          0,
          limit - 1
        )

    };

  }

  if (
    old.count >= limit
  ) {

    return {

      allowed: false,

      remaining: 0,

      retryAfter:
        Math.ceil(
          (
            old.resetAt -
            now
          ) / 1000
        )

    };

  }

  old.count += 1;

  RATE_LIMIT_MEMORY.set(
    storageKey,
    old
  );

  return {

    allowed: true,

    remaining:
      Math.max(
        0,
        limit -
        old.count
      )

  };

}

// ============================================================
// CLEAN MEMORY RATE LIMIT
// ============================================================

function cleanupRateLimitMemory() {

  const now =
    Date.now();

  for (
    const [
      key,
      value
    ]
    of RATE_LIMIT_MEMORY
  ) {

    if (
      !value ||
      value.resetAt <= now
    ) {

      RATE_LIMIT_MEMORY.delete(
        key
      );

    }

  }

  if (
    RATE_LIMIT_MEMORY.size >
    5000
  ) {

    RATE_LIMIT_MEMORY.clear();

  }

}

// ============================================================
// APP SECURITY
// ============================================================

async function checkAppSecurity(
  request,
  env
) {

  const uaSettings = await getServerUASettings();
  const ua =
    (
      request.headers.get(
        "User-Agent"
      ) || ""
    ).toLowerCase();

  const appKey =
    request.headers.get(
      "X-App-Key"
    ) || "";

  if (
    !ua.includes(
      uaSettings.newUA.toLowerCase()
    )
  ) {

    return {

      allowed: false,

      reason: "ua"

    };

  }

  if (!env.APP_SECRET) {

    console.error(
      "APP_SECRET is not configured"
    );

    return {

      allowed: false,

      reason: "server"

    };

  }

  if (
    appKey !==
    env.APP_SECRET
  ) {

    return {

      allowed: false,

      reason: "key"

    };

  }

  return {

    allowed: true

  };

}

// ============================================================
// SECURITY GUARD
// ============================================================

async function securityGuard(
  request,
  env,
  type = "play"
) {

  const ip =
    getClientIP(
      request
    );

  const security =
    await checkAppSecurity(
      request,
      env
    );

  // ==========================================================
  // INVALID REQUEST
  // ==========================================================

  if (
    !security.allowed
  ) {

    console.warn(
      "APP_SECURITY_DENIED",
      {
        reason:
          security.reason ||
          "unknown"
      }
    );

    const ipHash =
      await sha256(
        ip
      );

    const invalidLimit =
      await checkRateLimit(
        env,
        `invalid:${ipHash}`,
        INVALID_RATE_LIMIT,
        INVALID_RATE_WINDOW
      );

    if (
      !invalidLimit.allowed
    ) {

      return {

        allowed: false,

        response:
          new Response(
            "Too Many Requests",
            {
              status: 429,

              headers: {

                "Content-Type":
                  "text/plain; charset=utf-8",

                "Retry-After":
                  String(
                    invalidLimit.retryAfter ||
                    INVALID_RATE_WINDOW
                  ),

                "Cache-Control":
                  "no-store"

              }
            }
          )

      };

    }

    return {

      allowed: false,

      response:
        text(
          "Forbidden",
          403
        )

    };

  }

  // ==========================================================
  // PLAY RATE LIMIT
  // ==========================================================

  if (
    type === "play"
  ) {

    const appKey =
      request.headers.get(
        "X-App-Key"
      ) || "";

    const combined =
      `${ip}:${appKey}`;

    const keyHash =
      await sha256(
        combined
      );

    const rate =
      await checkRateLimit(
        env,
        `play:${keyHash}`,
        PLAY_RATE_LIMIT,
        PLAY_RATE_WINDOW
      );

    if (
      !rate.allowed
    ) {

      return {

        allowed: false,

        response:
          new Response(
            "Too Many Requests",
            {
              status: 429,

              headers: {

                "Content-Type":
                  "text/plain; charset=utf-8",

                "Retry-After":
                  String(
                    rate.retryAfter ||
                    PLAY_RATE_WINDOW
                  ),

                "Cache-Control":
                  "no-store"

              }
            }
          )

      };

    }

  }

  return {

    allowed: true

  };

}

// ============================================================
// LOAD CHANNELS FROM GITHUB
// ============================================================
//
// المصدر الأساسي:
//
// GitHub Raw
//
// https://raw.githubusercontent.com/
// SUPERTV18/super-tv-worker/main/public/data/channels.json
//
// لا يستخدم KV.
// ============================================================

async function loadChannels(env) {

  const now =
    Date.now();

  // ==========================================================
  // 1. MEMORY CACHE
  // ==========================================================

  if (
    CHANNELS_MEMORY_CACHE &&
    (
      now -
      CHANNELS_MEMORY_CACHE_TIME
    ) <
    CHANNELS_MEMORY_TTL
  ) {

    return CHANNELS_MEMORY_CACHE;

  }

  // ==========================================================
  // 2. CLOUDFLARE CACHE
  // ==========================================================

  try {

    const githubRequest =
      new Request(
        CHANNELS_GITHUB_URL,
        {
          method: "GET",

          headers: {
            "Accept":
              "application/json",

            "User-Agent":
              "SUPER-TV-Worker"
          }
        }
      );

    // --------------------------------------------------------
    // Cloudflare Cache
    // --------------------------------------------------------

    const cachedResponse =
      await caches.default.match(
        githubRequest
      );

    if (
      cachedResponse
    ) {

      try {

        const data =
          await cachedResponse.json();

        if (
          data &&
          typeof data === "object"
        ) {

          CHANNELS_MEMORY_CACHE =
            data;

          CHANNELS_MEMORY_CACHE_TIME =
            now;

          return data;

        }

      } catch (e) {

        console.error(
          "CACHED CHANNELS JSON ERROR:",
          e
        );

      }

    }

    // ========================================================
    // 3. GITHUB FETCH
    // ========================================================

    const response =
      await fetch(
        githubRequest,
        {
          redirect:
            "follow",

          cf: {
            cacheEverything:
              true,

            cacheTtl:
              CHANNELS_CACHE_TTL
          }
        }
      );

    if (
      !response.ok
    ) {

      throw new Error(
        `GitHub returned HTTP ${response.status}`
      );

    }

    const data =
      await response.json();

    if (
      !data ||
      typeof data !== "object"
    ) {

      throw new Error(
        "Invalid channels.json format"
      );

    }

    // ========================================================
    // SAVE TO MEMORY
    // ========================================================

    CHANNELS_MEMORY_CACHE =
      data;

    CHANNELS_MEMORY_CACHE_TIME =
      now;

    // ========================================================
    // SAVE TO CLOUDFLARE CACHE
    // ========================================================

    try {

      const cacheResponse =
        new Response(
          JSON.stringify(data),
          {
            status: 200,

            headers: {
              "Content-Type":
                "application/json",

              "Cache-Control":
                `public, max-age=${CHANNELS_CACHE_TTL}`
            }
          }
        );

      await caches.default.put(
        githubRequest,
        cacheResponse
      );

    } catch (cacheError) {

      console.error(
        "CHANNELS CACHE PUT ERROR:",
        cacheError
      );

    }

    return data;

  } catch (e) {

    console.error(
      "GITHUB CHANNELS ERROR:",
      e
    );

    // ========================================================
    // 4. STALE MEMORY FALLBACK
    // ========================================================
    //
    // إذا فشل GitHub وكان Worker لديه نسخة قديمة
    // يتم استخدامها بدل إيقاف القنوات.
    // ========================================================

    if (
      CHANNELS_MEMORY_CACHE
    ) {

      console.warn(
        "USING STALE MEMORY CHANNELS CACHE"
      );

      return CHANNELS_MEMORY_CACHE;

    }

    throw new Error(
      "channels.json could not be loaded from GitHub"
    );

  }

}

// ============================================================
// CHANNELS API
// ============================================================

async function channelsApi(
  request,
  env
) {

  try {

    const data =
      await loadChannels(
        env
      );

    return json(
      data
    );

  } catch (e) {

    console.error(
      "CHANNELS ERROR:",
      e
    );

    return json(
      {
        error:
          e.message
      },
      500
    );

  }

}

// ============================================================
// ALLOWED CHANNEL HEADERS
// ============================================================

const ALLOWED_CHANNEL_HEADERS =
  new Set([
    "user-agent",
    "referer",
    "origin"
  ]);

// ============================================================
// NORMALIZE CHANNEL HEADERS
// ============================================================

function normalizeChannelHeaders(
  value
) {

  const result = {};

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {

    return result;

  }

  for (
    const [
      name,
      rawValue
    ]
    of Object.entries(value)
  ) {

    const normalizedName =
      name.toLowerCase();

    if (
      !ALLOWED_CHANNEL_HEADERS.has(
        normalizedName
      )
    ) {

      continue;

    }

    if (
      typeof rawValue !==
      "string" ||
      !rawValue.trim()
    ) {

      continue;

    }

    result[
      normalizedName
    ] =
      rawValue.trim();

  }

  return result;

}

// ============================================================
// GET UPSTREAM HEADERS
// ============================================================

function getUpstreamHeaders(
  target,
  channelHeaders = {},
  proxyUA = DEFAULT_PROXY_UA
) {

  const headers = {

    "User-Agent":
      (proxyUA || DEFAULT_PROXY_UA)

  };

  try {

    const parsed =
      new URL(
        target
      );

    if (
      parsed.hostname
        .toLowerCase()
        .includes(
          "ostora"
        )
    ) {

      headers.Referer =
        "https://ostora.pages.dev/";

    }

  } catch {}

  for (
    const [
      name,
      value
    ]
    of Object.entries(
      normalizeChannelHeaders(
        channelHeaders
      )
    )
  ) {

    const canonicalName =
      name
        .split("-")
        .map(
          part =>
            part.charAt(0)
              .toUpperCase() +
            part.slice(1)
        )
        .join("-");

    headers[
      canonicalName
    ] =
      value;

  }

  return headers;

}

// ============================================================
// FETCH UPSTREAM
// ============================================================

async function fetchUpstream(
  target,
  request,
  channelHeaders = {},
  proxyUA = DEFAULT_PROXY_UA
) {

  const headers =
    getUpstreamHeaders(
      target,
      channelHeaders,
      proxyUA
    );

  const range =
    request.headers.get(
      "Range"
    );

  if (range) {

    headers.Range =
      range;

  }

  return fetch(
    target,
    {

      method:
        request.method ===
        "HEAD"
          ? "HEAD"
          : "GET",

      redirect:
        "follow",

      headers

    }
  );

}

// ============================================================
// IS M3U8
// ============================================================

function isProbablyM3U8(
  url,
  contentType = ""
) {

  const lowerUrl =
    url.toLowerCase();

  const lowerType =
    contentType.toLowerCase();

  return (

    lowerType.includes(
      "mpegurl"
    ) ||

    lowerType.includes(
      "vnd.apple.mpegurl"
    ) ||

    lowerUrl.includes(
      ".m3u8"
    )

  );

}

// ============================================================
// REWRITE HLS MANIFEST
// ============================================================

async function rewriteHLSManifest(
  env,
  body,
  sourceUrl,
  workerOrigin,
  channelHeaders = {}
) {

  const lines =
    body.split(
      /\r?\n/
    );

  const output = [];

  for (
    let line
    of lines
  ) {

    const original =
      line.trim();

    if (
      original.startsWith("#")
    ) {

      line =
        await rewriteURIAttributes(
          env,
          line,
          sourceUrl,
          workerOrigin,
          channelHeaders
        );

      output.push(
        line
      );

      continue;

    }

    if (!original) {

      output.push(
        line
      );

      continue;

    }

    try {

      const absolute =
        new URL(
          original,
          sourceUrl
        ).toString();

      const token =
        await createHLSToken(
          env,
          absolute,
          channelHeaders
        );

      output.push(
        `${workerOrigin}/api/hls?token=${encodeURIComponent(token)}`
      );

    } catch {

      output.push(
        line
      );

    }

  }

  return output.join(
    "\n"
  );

}

// ============================================================
// REWRITE URI ATTRIBUTES
// ============================================================

async function rewriteURIAttributes(
  env,
  line,
  sourceUrl,
  workerOrigin,
  channelHeaders = {}
) {

  const regex =
    /URI="([^"]+)"/gi;

  const matches =
    [
      ...line.matchAll(
        regex
      )
    ];

  if (
    !matches.length
  ) {

    return line;

  }

  let result =
    line;

  for (
    let i =
      matches.length - 1;
    i >= 0;
    i--
  ) {

    const match =
      matches[i];

    const originalUri =
      match[1];

    try {

      const absolute =
        new URL(
          originalUri,
          sourceUrl
        ).toString();

      const token =
        await createHLSToken(
          env,
          absolute,
          channelHeaders
        );

      const replacement =
        `${workerOrigin}/api/hls?token=${encodeURIComponent(token)}`;

      result =
        result.slice(
          0,
          match.index + 5
        ) +
        replacement +
        result.slice(
          match.index +
          5 +
          originalUri.length
        );

    } catch {}

  }

  return result;

}

// ============================================================
// HLS ENTRY POINT
// ============================================================

async function hlsApi(
  request,
  env,
  url
) {

  const security =
    await securityGuard(
      request,
      env,
      "proxy"
    );

  if (
    !security.allowed
  ) {

    return security.response;

  }

  const token =
    url.searchParams.get(
      "token"
    );

  if (!token) {

    return text(
      "Missing token",
      400
    );

  }

  const decoded =
    await verifyHLSToken(
      env,
      token
    );

  if (!decoded) {

    return text(
      "Invalid or expired token",
      403
    );

  }

  // Check block list on every HLS request, including playlist and segment requests.
  try {
    if (env.TRACKER) {
      const sessionHash = await sha256(getClientIP(request) + "|" + (request.headers.get("User-Agent") || ""));
      const stub = env.TRACKER.get(env.TRACKER.idFromName("global-viewers"));
      const check = await stub.fetch("https://viewer-tracker/is-blocked", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sessionHash })
      });
      if (check.ok && (await check.json()).blocked) return text("هذا الجهاز محظور من تشغيل البث", 403);
    }
  } catch (e) { console.warn("BLOCK_CHECK_ERROR", String(e.message || e)); }

  // Refresh the viewer heartbeat from HLS segment/playlist requests.
  // Durable Object throttles writes per session; no KV operations are used.
  try {
    if (env.TRACKER) {
      const ip = getClientIP(request);
      const ua = request.headers.get("User-Agent") || "";
      const sessionHash = await sha256(ip + "|" + ua);
      const stub = env.TRACKER.get(env.TRACKER.idFromName("global-viewers"));
      await stub.fetch("https://viewer-tracker/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionHash,
          ip,
          ua,
          country: request.cf?.country || "",
          city: request.cf?.city || "",
          org: request.cf?.asOrganization || "",
          now: Date.now()
        })
      });
    }
  } catch (viewerError) {
    console.warn("VIEWER_HEARTBEAT_ERROR", String(viewerError.message || viewerError));
  }

  const target =
    decoded.url;

  let targetUrl;

  try {

    targetUrl =
      new URL(
        target
      );

    if (
      targetUrl.protocol !==
        "http:" &&
      targetUrl.protocol !==
        "https:"
    ) {

      return text(
        "Invalid upstream protocol",
        400
      );

    }

  } catch {

    return text(
      "Invalid upstream URL",
      400
    );

  }

  try {

    const uaSettings = await getServerUASettings();
    const upstream =
      await fetchUpstream(
        targetUrl.toString(),
        request,
        decoded.headers,
        uaSettings.proxyUA
      );

    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "";

    // Safe diagnostics for failed HLS requests; never log full URLs or tokens.
    if (!upstream.ok) {
      console.warn(
        "HLS_UPSTREAM_FAILURE",
        JSON.stringify({
          status: upstream.status,
          host: targetUrl.hostname,
          contentType: contentType.slice(0, 100),
          rangeRequested: Boolean(request.headers.get("Range"))
        })
      );
    }

    // Some providers serve nested HLS playlists through .css URLs.
    // Inspect the response body before deciding to stream it as binary.
    let isHLSManifest =
      isProbablyM3U8(
        upstream.url || targetUrl.toString(),
        contentType
      );

    let detectedManifestBody = null;

    if (!isHLSManifest) {
      const finalUrl = upstream.url || targetUrl.toString();
      let looksLikePlaylist = false;

      try {
        const finalParsed = new URL(finalUrl);
        const requestedParsed = new URL(targetUrl.toString());

        looksLikePlaylist =
          /\.css$/i.test(finalParsed.pathname) ||
          /\.css$/i.test(requestedParsed.pathname) ||
          finalParsed.hostname.toLowerCase().includes("majedcss.site");
      } catch {}

      if (looksLikePlaylist) {
        const candidateBody = await upstream.clone().text();
        const trimmedBody = candidateBody.replace(/^\uFEFF/, "").trimStart();

        if (trimmedBody.startsWith("#EXTM3U")) {
          isHLSManifest = true;
          detectedManifestBody = candidateBody;
        }
      }
    }

    if (isHLSManifest) {

      const body =
        detectedManifestBody !== null
          ? detectedManifestBody
          : await upstream.text();

      const rewritten =
        await rewriteHLSManifest(
          env,
          body,
          targetUrl.toString(),
          url.origin,
          decoded.headers
        );

      return new Response(
        rewritten,
        {

          status:
            upstream.status,

          headers: {

            "Content-Type":
              "application/vnd.apple.mpegurl",

            "Access-Control-Allow-Origin":
              "*",

            "Cache-Control":
              "no-store",

            "X-Content-Type-Options":
              "nosniff"

          }

        }
      );

    }

    const headers =
      new Headers();

    if (contentType) {

      headers.set(
        "Content-Type",
        contentType
      );

    }

    const contentLength =
      upstream.headers.get(
        "Content-Length"
      );

    if (contentLength) {

      headers.set(
        "Content-Length",
        contentLength
      );

    }

    const contentRange =
      upstream.headers.get(
        "Content-Range"
      );

    if (contentRange) {

      headers.set(
        "Content-Range",
        contentRange
      );

    }

    const acceptRanges =
      upstream.headers.get(
        "Accept-Ranges"
      );

    if (acceptRanges) {

      headers.set(
        "Accept-Ranges",
        acceptRanges
      );

    }

    headers.set(
      "Access-Control-Allow-Origin",
      "*"
    );

    headers.set(
      "Cache-Control",
      "no-store"
    );

    return new Response(
      upstream.body,
      {

        status:
          upstream.status,

        headers

      }
    );

  } catch (e) {

    console.error(
      "HLS PROXY ERROR:",
      e
    );

    return text(
      "HLS Proxy Error",
      500
    );

  }

}

// ============================================================
// PLAY M3U8
// ============================================================

async function playApi(
  request,
  env,
  url,
  forceRaw = false
) {

  try {

    const id =
      url.searchParams.get(
        "id"
      );

    if (!id) {

      return text(
        "Missing id",
        400
      );

    }

    // ========================================================
    // OLD UA
    // ========================================================

    const uaSettings = await getServerUASettings();
    const ua =
      request.headers.get(
        "User-Agent"
      ) || "";

    const lowerUA =
      ua.toLowerCase();

    if (
      lowerUA.includes(
        uaSettings.oldUA.toLowerCase()
      ) ||
      lowerUA.includes(
        "superlivetv"
      )
    ) {

      return Response.redirect(
        FALLBACK_VIDEO,
        302
      );

    }

    // ========================================================
    // SECURITY
    // ========================================================

    const security =
      await securityGuard(
        request,
        env,
        "play"
      );

    if (
      !security.allowed
    ) {

      return security.response;

    }

    if (env.TRACKER) {
      const sessionHash = await sha256(getClientIP(request) + "|" + (request.headers.get("User-Agent") || ""));
      const stub = env.TRACKER.get(env.TRACKER.idFromName("global-viewers"));
      const check = await stub.fetch("https://viewer-tracker/is-blocked", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sessionHash })
      });
      if (check.ok && (await check.json()).blocked) return text("هذا الجهاز محظور من تشغيل البث", 403);
    }

    // ========================================================
    // VIEWER
    // ========================================================

    incrementViewer(id);
    try {
      if (env.TRACKER) {
        const ip = getClientIP(request);
        const ua = request.headers.get("User-Agent") || "";
        const sessionHash = await sha256(ip + "|" + ua);
        const stub = env.TRACKER.get(env.TRACKER.idFromName("global-viewers"));
        await stub.fetch("https://viewer-tracker/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionHash,
            ip,
            ua,
            channelId: String(id),
            firstName: "",
            country: request.cf?.country || "",
            city: request.cf?.city || "",
            org: request.cf?.asOrganization || "",
            now: Date.now()
          })
        });
      }
    } catch (viewerError) {
      console.warn("VIEWER_TRACKING_ERROR", String(viewerError.message || viewerError));
    }

    // ========================================================
    // ADMIN API
    // ========================================================

    if (url.pathname.startsWith("/api/admin/")) {
      return adminApi(request, env, url);
    }

    // ========================================================
    // CHANNELS
    // ========================================================

    const data =
      await loadChannels(
        env
      );

    let channel =
      null;

    for (
      const group
      of Object.values(
        data
      )
    ) {

      if (
        !Array.isArray(
          group
        )
      ) {

        continue;

      }

      const found =
        group.find(
          ch =>
            String(
              ch.id
            ) ===
            String(
              id
            )
        );

      if (found) {

        channel =
          found;

        break;

      }

    }

    if (!channel) {

      return text(
        "Channel not found",
        404
      );

    }

    if (!channel.url) {

      return text(
        "Channel URL missing",
        404
      );

    }

    // ========================================================
    // SOURCE
    // ========================================================

    const cleanUrl =
      channel.url.split(
        "#"
      )[0];

    // ========================================================
    // CHANNEL HEADERS
    // ========================================================

    const channelHeaders =
      normalizeChannelHeaders(
        channel.headers
      );

    const headers =
      getUpstreamHeaders(
        cleanUrl,
        channelHeaders
      );

    // ========================================================
    // FETCH SOURCE
    // ========================================================

    const response =
      await fetch(
        cleanUrl,
        {

          redirect:
            "follow",

          headers

        }
      );

    let upstreamTarget =
      {};

    try {

      const responseUrl =
        new URL(
          response.url ||
          cleanUrl
        );

      upstreamTarget = {

        protocol:
          responseUrl.protocol,

        hostname:
          responseUrl.hostname,

        port:
          responseUrl.port ||
          (
            responseUrl.protocol ===
            "https:"
              ? "443"
              : "80"
          )

      };

    } catch {}

    const upstreamContentType =
      response.headers.get("content-type") || "";
    const upstreamContentLength =
      response.headers.get("content-length") || "";
    let finalTargetHost = "";
    try {
      finalTargetHost = new URL(response.url || cleanUrl).hostname;
    } catch {}

    // Diagnostic only: do not consume the response body or alter player behavior.
    console.log(
      "PLAY_UPSTREAM_RESPONSE",
      JSON.stringify({
        status: response.status,
        target: upstreamTarget,
        finalHost: finalTargetHost,
        contentType: upstreamContentType.slice(0, 120),
        contentLength: upstreamContentLength || null,
        redirected: response.redirected
      })
    );
    if (!response.ok) {
      recordAdminEvent({ type: "play_error", channelId: String(id), status: response.status, ok: false, host: finalTargetHost, message: "فشل المصدر أثناء التشغيل" });
    }

    // If the upstream explicitly reports a tiny body, inspect a clone only.
    // The live response body remains untouched for normal playback.
    const reportedLength = Number(upstreamContentLength);
    if (Number.isFinite(reportedLength) && reportedLength > 0 && reportedLength <= 1024) {
      try {
        const tinyBytes = new Uint8Array(await response.clone().arrayBuffer());
        const tinyHex = Array.from(tinyBytes.slice(0, 64))
          .map(byte => byte.toString(16).padStart(2, "0"))
          .join(" ");
        const tinyText = new TextDecoder()
          .decode(tinyBytes.slice(0, 256))
          .replace(/[^\\x20-\\x7E\\r\\n\\t]/g, ".");
        console.warn(
          "PLAY_UPSTREAM_TINY_BODY",
          JSON.stringify({
            length: tinyBytes.length,
            hex: tinyHex,
            printable: tinyText
          })
        );
      } catch (diagnosticError) {
        console.warn("PLAY_UPSTREAM_TINY_BODY_READ_FAILED");
      }
    }

    if (!response.ok) {

      return text(
        `Upstream error: ${response.status}`,
        response.status
      );

    }

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    const finalSourceUrl =
      response.url ||
      cleanUrl;

    // ========================================================
    // RAW STREAM PASSTHROUGH (FLV / OTHER NON-HLS)
    // Dedicated endpoint: /api/play.flv?id=TOD2
    // This forwards the original stream; it does not transcode it.
    // ========================================================

    if (forceRaw) {
      const rawHeaders = new Headers({
        "Content-Type": contentType || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });

      for (const headerName of ["content-length", "content-range", "accept-ranges"]) {
        const headerValue = response.headers.get(headerName);
        if (headerValue) rawHeaders.set(headerName, headerValue);
      }

      return new Response(response.body, {
        status: response.status,
        headers: rawHeaders
      });
    }

    // ========================================================
    // DETECT HLS EVEN WHEN THE SOURCE URL ENDS WITH .CSS
    // Some HLS providers expose an M3U8 manifest through a
    // .css URL and require a channel-specific User-Agent.
    // Inspect the body only for CSS-like source URLs so normal
    // binary/video responses can continue streaming untouched.
    // ========================================================

    let isHLSManifest =
      isProbablyM3U8(
        finalSourceUrl,
        contentType
      );

    let detectedManifestBody =
      null;

    if (!isHLSManifest) {

      let sourceLooksLikeCss =
        false;

      try {

        const parsedSource =
          new URL(
            finalSourceUrl
          );

        const parsedRequestedSource =
          new URL(
            cleanUrl
          );

        sourceLooksLikeCss =
          /\.css$/i.test(
            parsedSource.pathname
          ) ||
          /\.css$/i.test(
            parsedRequestedSource.pathname
          ) ||
          parsedSource.hostname
            .toLowerCase() ===
            "assets.pushyourcss.world";

      } catch {}

      if (sourceLooksLikeCss) {

        const candidateBody =
          await response.clone().text();

        const trimmedBody =
          candidateBody
            .replace(/^\uFEFF/, "")
            .trimStart();

        if (
          trimmedBody.startsWith(
            "#EXTM3U"
          )
        ) {

          isHLSManifest = true;
          detectedManifestBody =
            candidateBody;

        }

      }

    }

    // ========================================================
    // REWRITE HLS MANIFEST
    // ========================================================

    if (isHLSManifest) {

      const body =
        detectedManifestBody !== null
          ? detectedManifestBody
          : await response.text();

      const rewritten =
        await rewriteHLSManifest(
          env,
          body,
          finalSourceUrl,
          url.origin,
          channelHeaders
        );

      return new Response(
        rewritten,
        {

          status: 200,

          headers: {

            "Content-Type":
              "application/vnd.apple.mpegurl",

            "Access-Control-Allow-Origin":
              "*",

            "Cache-Control":
              "no-store",

            "X-Content-Type-Options":
              "nosniff"

          }

        }
      );

    }

    // ========================================================
    // NON M3U8 SOURCE
    // ========================================================

    return new Response(
      response.body,
      {

        status:
          response.status,

        headers: {

          "Content-Type":
            contentType ||
            "application/octet-stream",

          "Access-Control-Allow-Origin":
            "*",

          "Cache-Control":
            "no-store"

        }

      }
    );

  } catch (e) {

    console.error(
      "PLAY ERROR:",
      e
    );

    return text(
      "Server error: " +
      e.message,
      500
    );

  }

}

// ============================================================
// PLAYLIST M3U
// ============================================================

async function playlistApi(
  request,
  env,
  url
) {

  try {

    const data =
      await loadChannels(
        env
      );

    let m3u =
      "#EXTM3U\n";

    const host =
      url.origin;

    for (
      const category
      in data
    ) {

      const channels =
        data[
          category
        ];

      if (
        !Array.isArray(
          channels
        )
      ) {

        continue;

      }

      for (
        const ch
        of channels
      ) {

        m3u +=
          `#EXTINF:-1 tvg-id="${ch.id}" group-title="${category}",${ch.name}\n`;

        m3u +=
          `${host}/api/play.m3u8?id=${encodeURIComponent(ch.id)}\n`;

      }

    }

    return new Response(
      m3u,
      {

        status: 200,

        headers: {

          "Content-Type":
            "application/x-mpegURL",

          "Content-Disposition":
            'attachment; filename="SuperTV.m3u"',

          "Access-Control-Allow-Origin":
            "*",

          "Cache-Control":
            "no-store"

        }

      }
    );

  } catch (e) {

    console.error(
      "PLAYLIST ERROR:",
      e
    );

    return text(
      "Playlist error: " +
      e.message,
      500
    );

  }

}

// ============================================================
// OLD PROXY M3U8
// ============================================================

async function proxyM3u8Api(
  request,
  env,
  url
) {

  const security =
    await securityGuard(
      request,
      env,
      "proxy"
    );

  if (
    !security.allowed
  ) {

    return security.response;

  }

  const target =
    url.searchParams.get(
      "url"
    );

  if (!target) {

    return text(
      "Missing url",
      400
    );

  }

  try {

    const uaSettings = await getServerUASettings();
    const upstream =
      await fetchUpstream(
        target,
        request,
        {},
        uaSettings.proxyUA
      );

    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "";

    if (
      isProbablyM3U8(
        target,
        contentType
      )
    ) {

      const body =
        await upstream.text();

      const rewritten =
        await rewriteHLSManifest(
          env,
          body,
          upstream.url ||
            target,
          url.origin
        );

      return new Response(
        rewritten,
        {

          status:
            upstream.status,

          headers: {

            "Content-Type":
              "application/vnd.apple.mpegurl",

            "Access-Control-Allow-Origin":
              "*",

            "Cache-Control":
              "no-store"

          }

        }
      );

    }

    return new Response(
      upstream.body,
      {

        status:
          upstream.status,

        headers: {

          "Content-Type":
            contentType ||
            "application/octet-stream",

          "Access-Control-Allow-Origin":
            "*",

          "Cache-Control":
            "no-store"

        }

      }
    );

  } catch (e) {

    console.error(
      "PROXY ERROR:",
      e
    );

    return text(
      "Proxy error",
      500
    );

  }

}

// ============================================================
// OLD TS PROXY
// ============================================================

async function tsApi(
  request,
  env,
  url
) {

  const security =
    await securityGuard(
      request,
      env,
      "ts"
    );

  if (
    !security.allowed
  ) {

    return security.response;

  }

  const target =
    url.searchParams.get(
      "url"
    );

  if (!target) {

    return text(
      "Missing url",
      400
    );

  }

  try {

    const upstream =
      await fetchUpstream(
        target,
        request
      );

    return new Response(
      upstream.body,
      {

        status:
          upstream.status,

        headers: {

          "Content-Type":
            upstream.headers.get(
              "content-type"
            ) ||
            "video/mp2t",

          "Access-Control-Allow-Origin":
            "*"

        }

      }
    );

  } catch (e) {

    console.error(
      "TS ERROR:",
      e
    );

    return text(
      "TS Proxy Error",
      500
    );

  }

}

// ============================================================
// SAVE API
// ============================================================
//
// KV يستخدم هنا فقط للحفظ الإداري.
// تشغيل القنوات لا يستخدم KV.
// ============================================================

async function saveApi(
  request,
  env
) {

  const security =
    await securityGuard(
      request,
      env,
      "save"
    );

  if (
    !security.allowed
  ) {

    return security.response;

  }

  if (
    request.method !==
    "POST"
  ) {

    return json(
      {
        error:
          "Method not allowed"
      },
      405
    );

  }

  try {

    const body =
      await request.json();

    if (!env.DATA_KV) {

      return json(
        {
          error:
            "DATA_KV is not configured"
        },
        500
      );

    }

    await env.DATA_KV.put(
      "channels",
      JSON.stringify(
        body
      )
    );

    // تحديث Memory Cache فقط
    CHANNELS_MEMORY_CACHE =
      body;

    CHANNELS_MEMORY_CACHE_TIME =
      Date.now();

    return json(
      {
        status:
          "ok"
      }
    );

  } catch (e) {

    console.error(
      "SAVE ERROR:",
      e
    );

    return json(
      {
        error:
          e.message
      },
      500
    );

  }

}

// ============================================================
// ADMIN API (ADMIN_SECRET + GITHUB_TOKEN)
// Channel edits are committed to channels.json on GitHub.
// No KV reads/writes are used by the admin dashboard.
// ============================================================

function adminAuthorized(request, env) {
  const expected = env.ADMIN_SECRET || "";
  const supplied = request.headers.get("X-Admin-Key") || "";
  return Boolean(expected && supplied && supplied === expected);
}

function validateChannelsData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  let total = 0;
  for (const [group, items] of Object.entries(data)) {
    if (!group.trim() || !Array.isArray(items)) return false;
    for (const ch of items) {
      total++;
      if (!ch || typeof ch !== "object" || !String(ch.id || "").trim() ||
          !String(ch.name || "").trim() || !String(ch.url || "").trim()) return false;
      try {
        const u = new URL(ch.url);
        if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      } catch { return false; }
    }
  }
  return total <= 2000;
}

async function adminApi(request, env, url) {
  if (!adminAuthorized(request, env)) {
    return json({ error: "غير مصرح. تحقق من مفتاح الإدارة." }, 401);
  }

  if (url.pathname === "/api/admin/server-ua" && request.method === "GET") {
    const settings = await getServerUASettings();
    return json({ status: "ok", settings });
  }

  if (url.pathname === "/api/admin/server-ua" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "بيانات غير صالحة" }, 400); }
    const newUA = typeof body.newUA === "string" ? body.newUA.trim() : "";
    const oldUA = typeof body.oldUA === "string" ? body.oldUA.trim() : "";
    const proxyUA = typeof body.proxyUA === "string" ? body.proxyUA.trim() : "";
    if (!newUA || !oldUA || !proxyUA || newUA.length > 200 || oldUA.length > 200 || proxyUA.length > 512 || /[\\r\\n]/.test(newUA + oldUA + proxyUA)) {
      return json({ error: "أدخل قيمتي User-Agent صحيحتين، بحد أقصى 200 حرف لكل قيمة." }, 400);
    }
    try {
      const result = await saveServerUASettings(env, newUA, oldUA, proxyUA);
      return json({ status: "ok", message: "تم حفظ إعدادات User-Agent للسيرفر. قد يستغرق انتشارها حتى 30 ثانية.", settings: result.settings });
    } catch (e) {
      return json({ error: "تعذر حفظ إعدادات السيرفر", detail: e.message }, 502);
    }
  }

  if (url.pathname === "/api/admin/logs" && request.method === "GET") {
    return json({ status: "ok", scope: "ذاكرة Worker الحالية فقط؛ السجلات تُمسح عند تبديل النسخة أو إعادة تشغيلها", logs: ADMIN_EVENT_LOGS.slice(0, 100), timestamp: new Date().toISOString() });
  }


  // GitHub-backed channel history; admin authorization is enforced above.
  if (url.pathname === "/api/admin/history" && request.method === "GET") {
    if (!env.GITHUB_TOKEN) return json({ error: "يجب ضبط GITHUB_TOKEN لعرض سجل التعديلات." }, 503);
    const apiBase = "https://api.github.com/repos/SUPERTV18/super-tv-worker";
    const headers = {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "SUPER-TV-Admin"
    };
    const requestedSha = url.searchParams.get("sha");
    try {
      if (requestedSha) {
        if (!/^[0-9a-f]{7,40}$/i.test(requestedSha)) return json({ error: "معرّف النسخة غير صالح." }, 400);
        const response = await fetch(apiBase + "/contents/public/data/channels.json?ref=" + encodeURIComponent(requestedSha), { headers });
        const payload = await response.json();
        if (!response.ok) return json({ error: response.status === 404 ? "ملف القنوات غير موجود في هذه النسخة." : "تعذر قراءة النسخة من GitHub.", detail: payload.message }, response.status === 404 ? 404 : 502);
        const binary = atob(String(payload.content || "").replace(/\s/g, ""));
        const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
        const channels = JSON.parse(new TextDecoder().decode(bytes));
        if (!validateChannelsData(channels)) return json({ error: "النسخة التاريخية تحتوي بيانات قنوات غير صالحة." }, 422);
        return json({ sha: requestedSha, channels });
      }
      const response = await fetch(apiBase + "/commits?path=public/data/channels.json&per_page=30", { headers });
      const payload = await response.json();
      if (!response.ok) return json({ error: "تعذر تحميل سجل GitHub.", detail: payload.message }, 502);
      const commits = payload.map(item => ({
        sha: item.sha,
        message: item.commit?.message || "",
        date: item.commit?.committer?.date || item.commit?.author?.date || "",
        author: item.author?.login || item.commit?.author?.name || "غير معروف"
      }));
      return json({ status: "ok", commits });
    } catch (e) {
      return json({ error: "فشل الاتصال بسجل GitHub.", detail: String(e.message || e) }, 502);
    }
  }

  if (url.pathname === "/api/admin/restore" && request.method === "POST") {
    if (!env.GITHUB_TOKEN) return json({ error: "يجب ضبط GITHUB_TOKEN لاسترجاع النسخ." }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ error: "بيانات الطلب غير صالحة." }, 400); }
    const sha = String(body.sha || "");
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return json({ error: "معرّف النسخة غير صالح." }, 400);
    const apiUrl = "https://api.github.com/repos/SUPERTV18/super-tv-worker/contents/public/data/channels.json";
    const headers = {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "SUPER-TV-Admin"
    };
    try {
      const historicalResponse = await fetch(apiUrl + "?ref=" + encodeURIComponent(sha), { headers });
      const historical = await historicalResponse.json();
      if (!historicalResponse.ok) return json({ error: "تعذر قراءة النسخة المختارة.", detail: historical.message }, historicalResponse.status === 404 ? 404 : 502);
      const binary = atob(String(historical.content || "").replace(/\s/g, ""));
      const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      let data;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: "النسخة المختارة ليست JSON صالحًا." }, 422); }
      if (!validateChannelsData(data)) return json({ error: "النسخة المختارة تحتوي بيانات قنوات غير صالحة." }, 422);

      const currentResponse = await fetch(apiUrl, { headers });
      const current = await currentResponse.json();
      if (!currentResponse.ok) return json({ error: "تعذر قراءة النسخة الحالية.", detail: current.message }, 502);
      const encoded = btoa(Array.from(new TextEncoder().encode(JSON.stringify(data, null, 2)), b => String.fromCharCode(b)).join(""));
      const saveResponse = await fetch(apiUrl, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Restore channels from commit " + sha.slice(0, 7) + " via SUPER LIVE TV Admin",
          content: encoded,
          sha: current.sha,
          branch: "main"
        })
      });
      const saved = await saveResponse.json();
      if (!saveResponse.ok) return json({ error: "فشل حفظ النسخة المسترجعة.", detail: saved.message }, saveResponse.status === 409 ? 409 : 502);
      CHANNELS_MEMORY_CACHE = data;
      CHANNELS_MEMORY_CACHE_TIME = Date.now();
      try { await caches.default.delete(new Request(CHANNELS_GITHUB_URL, { method: "GET" })); } catch {}
      return json({ status: "ok", sha: saved.commit?.sha || null, message: "تم استرجاع القنوات وحفظها كتعديل جديد في GitHub." });
    } catch (e) {
      return json({ error: "فشل استرجاع النسخة.", detail: String(e.message || e) }, 502);
    }
  }

  if (url.pathname === "/api/admin/block" && (request.method === "POST" || request.method === "DELETE")) {
    let body = {}; try { body = await request.json(); } catch { return json({ error: "بيانات غير صالحة" }, 400); }
    const sessionId = String(body.sessionId || "");
    if (!/^[a-f0-9]{64}$/i.test(sessionId)) return json({ error: "معرّف الجهاز غير صالح" }, 400);
    if (!env.TRACKER) return json({ error: "Durable Object TRACKER غير مربوط" }, 503);
    try {
      const stub = env.TRACKER.get(env.TRACKER.idFromName("global-viewers"));
      const response = await stub.fetch("https://viewer-tracker/" + (request.method === "POST" ? "block" : "unblock"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, note: String(body.note || "").slice(0, 200), now: Date.now() })
      });
      return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    } catch (e) { return json({ error: "تعذر تحديث الحظر", detail: String(e.message || e) }, 502); }
  }

  if (url.pathname === "/api/admin/blocked" && request.method === "GET") {
    if (!env.TRACKER) return json({ error: "Durable Object TRACKER غير مربوط", blocked: [] }, 503);
    try {
      const stub = env.TRACKER.get(env.TRACKER.idFromName("global-viewers"));
      const response = await stub.fetch("https://viewer-tracker/blocked");
      return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    } catch (e) { return json({ error: "تعذر قراءة قائمة الحظر", detail: String(e.message || e), blocked: [] }, 502); }
  }

  if (url.pathname === "/api/admin/viewer-history" && request.method === "GET") {
    if (!env.TRACKER) return json({ error: "Durable Object TRACKER غير مربوط", viewers: [] }, 503);
    try {
      const stub = env.TRACKER.get(env.TRACKER.idFromName("global-viewers"));
      const response = await stub.fetch("https://viewer-tracker/history?limit=" + encodeURIComponent(url.searchParams.get("limit") || "500"));
      const data = await response.json();
      if (response.ok && Array.isArray(data.viewers)) {
        const blockedResponse = await stub.fetch("https://viewer-tracker/blocked");
        const blockedData = blockedResponse.ok ? await blockedResponse.json() : { blocked: [] };
        const blockedIds = new Set((blockedData.blocked || []).map(v => String(v.sessionId)));
        data.viewers = data.viewers.map(v => ({ ...v, blocked: blockedIds.has(String(v.sessionId)),
          device: v.device || classifyViewerDevice(v.ua), app: v.app || classifyViewerApp(v.ua) }));
        data.blockedCount = blockedIds.size;
      }
      return json(data, response.status);
    } catch (e) { return json({ error: "تعذر قراءة سجل المشاهدين", detail: String(e.message || e), viewers: [] }, 502); }
  }

  if (url.pathname === "/api/admin/viewers" && request.method === "GET") {
    if (!env.TRACKER) return json({ error: "Durable Object TRACKER غير مربوط بإعدادات Worker.", status: "unavailable", viewers: [] }, 503);
    try {
      const stub = env.TRACKER.get(env.TRACKER.idFromName("global-viewers"));
      const response = await stub.fetch("https://viewer-tracker/list", { method: "GET" });
      const data = await response.json();
      if (response.ok && Array.isArray(data.viewers)) {
        try {
          const blockResponse = await stub.fetch("https://viewer-tracker/blocked");
          const blockData = blockResponse.ok ? await blockResponse.json() : { blocked: [] };
          const blockedIds = new Set((blockData.blocked || []).map(v => String(v.sessionId)));
          data.viewers = data.viewers.map(v => ({ ...v, blocked: blockedIds.has(String(v.sessionId)) }));
        } catch {}
        try {
          const channels = await loadChannels(env);
          const index = new Map();
          for (const [group, items] of Object.entries(channels)) {
            if (!Array.isArray(items)) continue;
            for (const ch of items) index.set(String(ch.id), { name: String(ch.name || ch.id), group });
          }
          data.viewers = data.viewers.map(v => ({
            ...v,
            device: v.device || classifyViewerDevice(v.ua),
            app: v.app || classifyViewerApp(v.ua),
            name: index.get(String(v.ch))?.name || String(v.ch),
            group: index.get(String(v.ch))?.group || ""
          }));
        } catch {}
      }
      return json({ ...data, status: response.ok ? "ok" : "unavailable" }, response.status);
    } catch (e) {
      return json({ error: "تعذر قراءة جلسات المشاهدة", detail: String(e.message || e), viewers: [] }, 502);
    }
  }

  if (url.pathname === "/api/admin/check-channels" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch {}
    let data;
    try { data = await loadChannels(env); } catch (e) { return json({ error: "تعذر تحميل القنوات", detail: e.message }, 500); }
    const wanted = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
    const candidates = [];
    for (const [group, items] of Object.entries(data)) {
      if (!Array.isArray(items)) continue;
      for (const ch of items) {
        if (ch && ch.url && (!wanted || wanted.has(String(ch.id)))) candidates.push({ id: String(ch.id), name: String(ch.name || ch.id), group, url: String(ch.url), headers: ch.headers || {} });
      }
    }
    const batch = candidates.slice(0, 25);
    const results = [];
    for (const ch of batch) {
      const started = Date.now();
      try {
        const target = new URL(ch.url);
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Unsupported protocol");
        const uaSettings = await getServerUASettings();
        const headers = getUpstreamHeaders(target.href, ch.headers, uaSettings.proxyUA);
        const response = await fetch(target.href, { method: "GET", redirect: "follow", headers });
        const contentType = response.headers.get("content-type") || "";
        let playlistText = "";
        let playlistDetected = false;
        let firstMediaUri = "";
        let playlistKind = "";
        // Read only a small prefix, then cancel; never download a full playlist.
        if (response.ok && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let bytes = 0;
          try {
            while (bytes < 16384) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              playlistText += decoder.decode(part.value, { stream: true });
              if (playlistText.includes("#EXTM3U") && playlistText.includes("\\n")) break;
              if (bytes >= 16384) break;
            }
          } finally {
            try { await reader.cancel(); } catch {}
          }
          playlistDetected = playlistText.trimStart().startsWith("#EXTM3U");
          if (playlistDetected) {
            const lines = playlistText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            playlistKind = lines.some(line => line.startsWith("#EXT-X-STREAM-INF")) ? "master"
              : lines.some(line => line.startsWith("#EXTINF")) ? "media" : "playlist";
            const afterExtinf = lines.findIndex(line => line.startsWith("#EXTINF"));
            const nextUri = afterExtinf >= 0 ? lines.slice(afterExtinf + 1).find(line => !line.startsWith("#")) : "";
            const variantIndex = lines.findIndex(line => line.startsWith("#EXT-X-STREAM-INF"));
            const nextVariant = variantIndex >= 0 ? lines.slice(variantIndex + 1).find(line => !line.startsWith("#")) : "";
            firstMediaUri = nextUri || nextVariant || "";
          }
        } else {
          try { await response.body?.cancel(); } catch {}
        }
        let segmentStatus = null;
        let segmentElapsedMs = null;
        let segmentError = "";
        if (response.ok && playlistDetected && firstMediaUri) {
          try {
            const mediaUrl = new URL(firstMediaUri, response.url || target.href);
            if (mediaUrl.protocol !== "http:" && mediaUrl.protocol !== "https:") throw new Error("Unsupported media URL protocol");
            const mediaStarted = Date.now();
            const mediaResponse = await fetch(mediaUrl.href, {
              method: "GET",
              redirect: "follow",
              headers: { ...headers, Range: "bytes=0-0" }
            });
            segmentStatus = mediaResponse.status;
            segmentElapsedMs = Date.now() - mediaStarted;
            try { await mediaResponse.body?.cancel(); } catch {}
            if (!mediaResponse.ok && mediaResponse.status !== 206) segmentError = "أول ملف تابع للقائمة لم يستجب بنجاح";
          } catch (mediaError) {
            segmentError = String(mediaError.message || mediaError);
          }
        }
        const category = response.status === 403 ? "source_forbidden"
          : response.status === 401 ? "source_unauthorized"
          : response.status === 404 ? "source_not_found"
          : response.status >= 500 ? "upstream_server_error"
          : response.status >= 400 ? "http_error"
          : !response.ok ? "http_redirect_or_other"
          : playlistDetected && segmentStatus !== null && !(segmentStatus >= 200 && segmentStatus < 300) ? "hls_media_error"
          : response.ok ? "http_ok" : "http_redirect_or_other";
        const categoryLabel = response.status === 403 ? "رفض المصدر (403)"
          : response.status === 401 ? "يتطلب صلاحية (401)"
          : response.status === 404 ? "المصدر غير موجود (404)"
          : response.status >= 500 ? "خطأ في خادم المصدر"
          : response.status >= 400 ? "خطأ HTTP"
          : !response.ok ? "استجابة غير متوقعة"
          : playlistDetected && segmentStatus !== null && !(segmentStatus >= 200 && segmentStatus < 300) ? "قائمة HLS موجودة لكن أول ملف تابع فشل"
          : playlistDetected && segmentStatus !== null ? "قائمة HLS وأول ملف تابع استجابا"
          : playlistDetected ? "قائمة HLS موجودة؛ لم يُحدد ملف تابع للفحص"
          : "استجابة HTTP ناجحة — نوع البث غير مؤكد";
        const result = {
          id: ch.id, name: ch.name, group: ch.group, status: response.status,
          ok: response.ok && !(playlistDetected && segmentStatus !== null && !(segmentStatus >= 200 && segmentStatus < 300)),
          category, categoryLabel, playlistDetected, playlistKind,
          segmentStatus, segmentElapsedMs, segmentError,
          contentType, elapsedMs: Date.now() - started,
          finalHost: (() => { try { return new URL(response.url || target.href).hostname; } catch { return ""; } })(),
          checkedAt: new Date().toISOString()
        };
        results.push(result);
        recordAdminEvent({ type: "channel_check", channelId: ch.id, channel: ch.name, status: result.status, ok: result.ok, elapsedMs: result.elapsedMs, message: result.ok ? "فحص المصدر نجح" : "استجابة HTTP غير ناجحة" });
      } catch (e) {
        const result = { id: ch.id, name: ch.name, group: ch.group, status: 0, ok: false, category: "connection_error", categoryLabel: "فشل اتصال بالمصدر", contentType: "", elapsedMs: Date.now() - started, error: String(e.message || e), checkedAt: new Date().toISOString() };
        results.push(result);
        recordAdminEvent({ type: "channel_check", channelId: ch.id, channel: ch.name, status: 0, ok: false, elapsedMs: result.elapsedMs, message: result.error });
      }
    }
    return json({ status: "ok", checked: results.length, totalAvailable: candidates.length, limited: candidates.length > batch.length, results, timestamp: new Date().toISOString() });
  }

  if (url.pathname === "/api/admin/stats" && request.method === "GET") {
    let channelCount = 0;
    let groupCount = 0;
    let viewerTotal = 0;
    const viewers = [];
    try {
      const data = await loadChannels(env);
      groupCount = Object.keys(data).length;
      for (const [group, items] of Object.entries(data)) {
        if (!Array.isArray(items)) continue;
        channelCount += items.length;
        for (const ch of items) {
          const v = VIEWERS_MEMORY.get(String(ch.id));
          const count = v && v.resetAt > Date.now() ? v.count : 0;
          viewerTotal += count;
          viewers.push({ id: String(ch.id), name: ch.name || String(ch.id), group, viewers: count });
        }
      }
      return json({
        status: "ok",
        channelCount,
        groupCount,
        activeViewerRequests: viewerTotal,
        viewerStatsScope: "عداد طلبات مؤقت داخل ذاكرة Worker؛ الجلسات الفعلية تُعرض من Durable Object",
        viewers,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      return json({ error: "تعذر تحميل القنوات", detail: e.message }, 500);
    }
  }

  if (url.pathname === "/api/admin/test" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "بيانات غير صالحة" }, 400); }
    let target;
    try {
      target = new URL(String(body.url || ""));
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("protocol");
    } catch { return json({ error: "رابط غير صالح" }, 400); }
    try {
      const uaSettings = await getServerUASettings();
      const headers = getUpstreamHeaders(target.href, body.headers || {}, uaSettings.proxyUA);
      const response = await fetch(target.href, { method: "GET", redirect: "follow", headers });
      const result = {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") || "",
        contentLength: response.headers.get("content-length") || null,
        redirected: response.redirected,
        finalHost: (() => { try { return new URL(response.url || target.href).hostname; } catch { return ""; } })()
      };
      try { await response.body?.cancel(); } catch {}
      recordAdminEvent({ type: "source_test", status: result.status, ok: result.ok, host: result.finalHost, elapsedMs: null, message: result.ok ? "اختبار المصدر نجح" : "المصدر أعاد HTTP " + result.status });
      return json(result);
    } catch (e) {
      return json({ error: "فشل الاتصال بالمصدر", detail: e.message }, 502);
    }
  }

  if (url.pathname === "/api/admin/channels" && request.method === "GET") {
    try { return json(await loadChannels(env)); }
    catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/api/admin/channels" && request.method === "POST") {
    if (!env.GITHUB_TOKEN) {
      return json({ error: "يجب ضبط GitHub Secret باسم GITHUB_TOKEN في إعدادات Worker." }, 503);
    }
    let data;
    try { data = await request.json(); } catch { return json({ error: "JSON غير صالح" }, 400); }
    if (!validateChannelsData(data)) {
      return json({ error: "بيانات القنوات غير صالحة. تأكد من المجموعة والمعرّف والاسم والرابط." }, 400);
    }
    const apiUrl = "https://api.github.com/repos/SUPERTV18/super-tv-worker/contents/public/data/channels.json";
    const apiHeaders = {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "SUPER-TV-Admin"
    };
    try {
      const currentResponse = await fetch(apiUrl, { headers: apiHeaders });
      if (!currentResponse.ok) throw new Error("GitHub read failed: " + currentResponse.status);
      const current = await currentResponse.json();
      const encoded = btoa(Array.from(new TextEncoder().encode(JSON.stringify(data, null, 2)), b => String.fromCharCode(b)).join(""));
      const saveResponse = await fetch(apiUrl, {
        method: "PUT",
        headers: { ...apiHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Update channels from SUPER LIVE TV Admin",
          content: encoded,
          sha: current.sha,
          branch: "main"
        })
      });
      const saveResult = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(saveResult.message || ("GitHub write failed: " + saveResponse.status));

      CHANNELS_MEMORY_CACHE = data;
      CHANNELS_MEMORY_CACHE_TIME = Date.now();
      try {
        const cachedRequest = new Request(CHANNELS_GITHUB_URL, { method: "GET" });
        await caches.default.delete(cachedRequest);
      } catch {}
      return json({ status: "ok", message: "تم حفظ القنوات في GitHub بنجاح", commit: saveResult.commit?.sha || null });
    } catch (e) {
      console.error("ADMIN CHANNEL SAVE ERROR", e.message);
      return json({ error: "فشل الحفظ إلى GitHub", detail: e.message }, 502);
    }
  }

  return json({ error: "Method not allowed" }, 405);
}

// ============================================================
// VIEWER INCREMENT
// ============================================================

function incrementViewer(
  id
) {

  try {

    const old =
      VIEWERS_MEMORY.get(
        String(id)
      );

    const now =
      Date.now();

    if (
      !old ||
      !old.resetAt ||
      old.resetAt <= now
    ) {

      VIEWERS_MEMORY.set(
        String(id),
        {

          count: 1,

          resetAt:
            now + 60 * 1000,

          lastActivity:
            now

        }
      );

      return;

    }

    old.count += 1;

    old.lastActivity =
      now;

    VIEWERS_MEMORY.set(
      String(id),
      old
    );

  } catch (e) {

    console.error(
      "VIEWER MEMORY ERROR:",
      e
    );

  }

}

// ============================================================
// VIEWERS API
// ============================================================

async function viewersApi(
  request,
  env,
  url
) {

  const id =
    url.searchParams.get(
      "id"
    );

  if (!id) {

    return json(
      {
        error:
          "Missing id"
      },
      400
    );

  }

  const key =
    String(id);

  const data =
    VIEWERS_MEMORY.get(
      key
    );

  return json({

    [id]:
      data?.count || 0

  });

}

// ============================================================
// STATIC ASSETS
// ============================================================

async function serveAsset(
  request,
  env
) {

  if (!env.ASSETS) {

    return text(
      "Assets binding not configured",
      500
    );

  }

  return env.ASSETS.fetch(
    request
  );

}

// ============================================================
// MAIN WORKER
// ============================================================

function classifyViewerDevice(ua) {
  const s = String(ua || "").toLowerCase();
  if (/android|dalvik|exoplayer|stagefright/.test(s)) return "Android";
  if (/iphone|ipad|ipod|cfnetwork|applecoremedia/.test(s)) return "iPhone / iPad";
  if (/tizen|webos|smart-?tv|hbbtv|bravia|roku|aftb|fire ?tv/.test(s)) return "Smart TV";
  if (/windows/.test(s)) return "Windows";
  if (/macintosh|mac os/.test(s)) return "macOS";
  if (/linux/.test(s)) return "Linux";
  return "غير معروف";
}
function classifyViewerApp(ua) {
  const s = String(ua || "").toLowerCase();
  if (/vlc/.test(s)) return "VLC";
  if (/iptv smarters|smarters/.test(s)) return "IPTV Smarters";
  if (/tivimate/.test(s)) return "TiviMate";
  if (/kodi/.test(s)) return "Kodi";
  if (/ott navigator|ottplayer/.test(s)) return "OTT Player";
  if (/exoplayer/.test(s)) return "مشغّل يعتمد ExoPlayer";
  if (/stagefright/.test(s)) return "مشغّل Android";
  if (/okhttp|dalvik/.test(s)) return "تطبيق Android (غير محدد)";
  if (/chrome|firefox|safari|edg\//.test(s)) return "متصفح";
  return "غير معروف";
}

// Durable Object-backed viewer sessions and persistent block list. No KV writes.
export class ViewerTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const ACTIVE_MS = 2 * 60 * 1000;

    if (url.pathname === "/block" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const sessionId = String(body.sessionId || "");
      if (!/^[a-f0-9]{64}$/i.test(sessionId)) return json({ error: "Invalid sessionId" }, 400);
      const viewer = await this.state.storage.get("viewer:" + sessionId);
      const record = { sessionId, ip: String(viewer?.ip || ""), ua: String(viewer?.ua || ""),
        device: classifyViewerDevice(viewer?.ua || ""), app: classifyViewerApp(viewer?.ua || ""),
        ch: String(viewer?.ch || ""), country: String(viewer?.country || ""), city: String(viewer?.city || ""),
        org: String(viewer?.org || ""), blockedAt: Number(body.now) || now, note: String(body.note || "").slice(0, 200) };
      await this.state.storage.put("blocked:" + sessionId, record);
      return json({ status: "ok", blocked: true });
    }
    if (url.pathname === "/unblock" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const sessionId = String(body.sessionId || "");
      if (!/^[a-f0-9]{64}$/i.test(sessionId)) return json({ error: "Invalid sessionId" }, 400);
      await this.state.storage.delete("blocked:" + sessionId);
      return json({ status: "ok", blocked: false });
    }
    if (url.pathname === "/blocked" && request.method === "GET") {
      const all = await this.state.storage.list({ prefix: "blocked:", limit: 2000 });
      const blocked = [...all.values()].sort((a, b) => Number(b.blockedAt) - Number(a.blockedAt));
      return json({ status: "ok", blocked, count: blocked.length });
    }
    if (url.pathname === "/is-blocked" && request.method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ blocked: false }, 400); }
      const sessionId = String(body.sessionId || "");
      if (!/^[a-f0-9]{64}$/i.test(sessionId)) return json({ blocked: false });
      const record = await this.state.storage.get("blocked:" + sessionId);
      return json({ blocked: Boolean(record), record: record || null });
    }

    if (url.pathname === "/heartbeat" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const sessionId = String(body.sessionId || "");
      const channelId = String(body.channelId || "");
      if (!/^[a-f0-9]{64}$/i.test(sessionId)) {
        return json({ error: "Invalid session data" }, 400);
      }

      const blocked = await this.state.storage.get("blocked:" + sessionId);
      if (blocked) return json({ error: "الجهاز محظور", blocked: true }, 403);
      const key = "viewer:" + sessionId;
      const existing = await this.state.storage.get(key);
      // Segment requests refresh activity but do not create an unknown session.
      if (!channelId && !existing) return json({ status: "ignored", reason: "session-not-found" });
      // Avoid a durable storage write for every HLS segment. Refresh at most once per
      // 15 seconds unless the viewer switches channels.
      if (existing &&
          (!channelId || channelId === String(existing.ch || "")) &&
          now - Number(existing.lastSeen || 0) < 15000) {
        return json({ status: "ok", throttled: true });
      }
      const previousLastSeen = Number(existing?.lastSeen || 0);
      const isNewVisit = !existing || now - previousLastSeen > ACTIVE_MS;
      const dateKey = new Date(Number(body.now) || now).toISOString().slice(0, 10);
      const record = {
        sessionId,
        ip: String(body.ip || existing?.ip || ""),
        ua: String(body.ua || existing?.ua || "").slice(0, 512),
        device: classifyViewerDevice(body.ua || existing?.ua || ""),
        app: classifyViewerApp(body.ua || existing?.ua || ""),
        ch: channelId || existing?.ch,
        firstSeen: existing?.firstSeen || Number(body.now) || now,
        // Throttle durable writes to once every 15 seconds per viewer session.
        lastSeen: existing && now - Number(existing.lastSeen || 0) < 15000
          ? existing.lastSeen
          : (Number(body.now) || now),
        country: String(body.country || existing?.country || "").slice(0, 80),
        city: String(body.city || existing?.city || "").slice(0, 100),
        org: String(body.org || existing?.org || "").slice(0, 160),
        name: channelId,
        group: ""
      };
      record.visitCount = Number(existing?.visitCount || 0) + (isNewVisit ? 1 : 0);
      record.channelsSeen = Array.isArray(existing?.channelsSeen) ? existing.channelsSeen : [];
      if (channelId && !record.channelsSeen.includes(channelId)) record.channelsSeen.push(channelId);
      record.channelsSeen = record.channelsSeen.slice(-100);
      await this.state.storage.put(key, record);
      if (isNewVisit) {
        const visitKey = "visit:" + String(Number(body.now) || now).padStart(13, "0") + ":" + sessionId;
        await this.state.storage.put(visitKey, {
          sessionId, at: Number(body.now) || now, date: dateKey, channelId: channelId || existing?.ch || "",
          ip: record.ip, ua: record.ua, device: record.device, app: record.app,
          country: record.country, city: record.city, org: record.org
        });
      }
      await this.state.storage.put("day:" + dateKey + ":" + sessionId, { sessionId, date: dateKey });
      return json({ status: "ok", newVisit: isNewVisit });
    }

    if (url.pathname === "/history" && request.method === "GET") {
      const all = await this.state.storage.list({ prefix: "viewer:", limit: 10000 });
      const viewers = [...all.values()].filter(v => v && v.sessionId)
        .sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit")) || 500));
      const visits = await this.state.storage.list({ prefix: "visit:", limit: 10000 });
      const nowMs = Date.now(), dayMs = 24 * 60 * 60 * 1000, weekMs = 7 * dayMs;
      let todayVisits = 0, weekVisits = 0;
      const todayUnique = new Set(), weekUnique = new Set();
      for (const v of visits.values()) {
        const at = Number(v.at || 0);
        if (at >= nowMs - dayMs) { todayVisits++; todayUnique.add(v.sessionId); }
        if (at >= nowMs - weekMs) { weekVisits++; weekUnique.add(v.sessionId); }
      }
      const dailyKeys = await this.state.storage.list({ prefix: "day:" + new Date().toISOString().slice(0, 10) + ":", limit: 10000 });
      const weekDates = new Set(Array.from({length: 7}, (_, i) => new Date(nowMs - i * dayMs).toISOString().slice(0, 10)));
      const dailyUnique = new Set(Array.from(dailyKeys.values(), v => v.sessionId));
      const weekDaily = await this.state.storage.list({ prefix: "day:", limit: 10000 });
      for (const v of weekDaily.values()) if (weekDates.has(v.date)) weekUnique.add(v.sessionId);
      return json({
        status: "ok", totalHistoricalViewers: viewers.length, totalVisits: visits.size,
        todayVisits, weekVisits, todayUniqueViewers: dailyUnique.size, weekUniqueViewers: weekUnique.size,
        viewers: viewers.slice(0, limit).map(v => ({...v, device: v.device || classifyViewerDevice(v.ua), app: v.app || classifyViewerApp(v.ua)})),
        timestamp: new Date().toISOString()
      });
    }

    if (url.pathname === "/list" && request.method === "GET") {
      const all = await this.state.storage.list({ prefix: "viewer:", limit: 2000 });
      const viewers = [];
      for (const [, v] of all) {
        if (!v || now - Number(v.lastSeen || 0) > ACTIVE_MS) continue;
        viewers.push(v);
      }
      viewers.sort((a, b) => Number(b.lastSeen) - Number(a.lastSeen));
      return json({ serverTime: now, viewers, activeSessions: viewers.length });
    }

    return json({ error: "Not found" }, 404);
  }
}

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );

    // Always serve the latest admin HTML directly and prevent browser/CDN caching.
    // This only affects the admin page; playback routes and KV bindings are unchanged.
    if (
      url.pathname === "/admin" ||
      url.pathname === "/admin/" ||
      url.pathname === "/admin.html"
    ) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/admin.html";
      const assetResponse = await env.ASSETS.fetch(
        new Request(assetUrl.toString(), request)
      );
      const headers = new Headers(assetResponse.headers);
      headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      headers.set("Pragma", "no-cache");
      headers.set("Expires", "0");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers
      });
    }

    // ========================================================
    // CLEAN OLD MEMORY DATA
    // ========================================================

    cleanupRateLimitMemory();

    // ========================================================
    // CORS
    // ========================================================

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {

          status: 204,

          headers: {

            "Access-Control-Allow-Origin":
              "*",

            "Access-Control-Allow-Methods":
              "GET,POST,OPTIONS",

            "Access-Control-Allow-Headers":
              "*"

          }

        }
      );

    }

    // ========================================================
    // ADMIN API (must be routed before playback endpoints)
    // ========================================================

    if (url.pathname.startsWith("/api/admin/")) {
      return adminApi(request, env, url);
    }

    // ========================================================
    // CHANNELS
    // ========================================================

    if (
      url.pathname ===
      "/api/channels"
    ) {

      return channelsApi(
        request,
        env
      );

    }

    // ========================================================
    // PLAY
    // ========================================================

    if (
      url.pathname ===
      "/api/play.m3u8"
    ) {

      return playApi(
        request,
        env,
        url
      );

    }

    // ========================================================
    // RAW STREAM PASSTHROUGH (FLV / NON-HLS)
    // ========================================================

    if (
      url.pathname ===
      "/api/play.flv"
    ) {

      return playApi(
        request,
        env,
        url,
        true
      );

    }

    // ========================================================
    // HIDDEN HLS PROXY
    // ========================================================

    if (
      url.pathname ===
      "/api/hls"
    ) {

      return hlsApi(
        request,
        env,
        url
      );

    }

    // ========================================================
    // PLAYLIST
    // ========================================================

    if (
      url.pathname ===
      "/api/playlist.m3u"
    ) {

      return playlistApi(
        request,
        env,
        url
      );

    }

    // ========================================================
    // PROXY M3U8
    // ========================================================

    if (
      url.pathname ===
      "/api/proxy.m3u8"
    ) {

      return proxyM3u8Api(
        request,
        env,
        url
      );

    }

    // ========================================================
    // TS
    // ========================================================

    if (
      url.pathname ===
      "/api/ts"
    ) {

      return tsApi(
        request,
        env,
        url
      );

    }

    // ========================================================
    // SAVE
    // ========================================================

    if (
      url.pathname ===
      "/api/save"
    ) {

      return saveApi(
        request,
        env
      );

    }

    // ========================================================
    // VIEWERS
    // ========================================================

    if (
      url.pathname ===
      "/api/viewers"
    ) {

      return viewersApi(
        request,
        env,
        url
      );

    }

    // ========================================================
    // ADMIN
    // ========================================================

    if (
      url.pathname ===
      "/admin"
    ) {

      const adminUrl =
        new URL(
          "/admin.html",
          request.url
        );

      return serveAsset(
        new Request(
          adminUrl,
          request
        ),
        env
      );

    }

    // ========================================================
    // STATIC
    // ========================================================

    return serveAsset(
      request,
      env
    );

  }

};
