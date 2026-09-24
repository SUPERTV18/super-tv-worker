// ============================================================
// SUPER TV API - Cloudflare Worker
// ============================================================

const NEW_UA = "stv2026";
const OLD_UA = "2026stv";

const PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/148.0.0.0 Safari/537.36";

const FALLBACK_VIDEO =
  "https://github.com/himasabry/video/raw/refs/heads/main/output.m3u8";

const PLAY_RATE_LIMIT = 30;
const INVALID_RATE_LIMIT = 15;
const PROXY_RATE_LIMIT = 60;
const RATE_WINDOW = 60;

const HLS_TOKEN_TTL = 30 * 60;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

const TEXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

// ============================================================
// MAIN
// ============================================================

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return corsResponse();
      }

      const url = new URL(request.url);
      const path = url.pathname;

      // ======================================================
      // API
      // ======================================================

      if (path === "/api/play.m3u8") {
        return await playApi(request, env, ctx);
      }

      if (path === "/api/hls") {
        return await hlsApi(request, env, ctx);
      }

      if (path === "/api/playlist.m3u8") {
        return await playlistApi(request, env, ctx);
      }

      if (path === "/api/proxy") {
        return await proxyM3u8Api(request, env, ctx);
      }

      if (path === "/api/ts") {
        return await tsApi(request, env, ctx);
      }

      if (path === "/api/save") {
        return await saveApi(request, env);
      }

      if (path === "/api/channels") {
        return await channelsApi(request, env);
      }

      if (path === "/api/viewers") {
        return await viewersApi(request, env);
      }

      if (path === "/api/admin") {
        return await adminApi(request, env);
      }

      // ======================================================
      // HEALTH
      // ======================================================

      if (path === "/") {
        return jsonResponse({
          ok: true,
          service: "SUPER TV API",
          worker: "super-tv-api",
          status: "running",
          time: new Date().toISOString(),
        });
      }

      if (path === "/health") {
        return jsonResponse({
          ok: true,
          status: "online",
        });
      }

      // ======================================================
      // ASSETS
      // ======================================================

      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return text("Not Found", 404);

    } catch (error) {
      console.error("WORKER ERROR:", error);

      return jsonResponse(
        {
          ok: false,
          error: "Internal Worker Error",
          message: String(error?.message || error),
        },
        500
      );
    }
  },
};

// ============================================================
// BASIC RESPONSES
// ============================================================

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, X-App-Key, Range, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...TEXT_HEADERS,
      ...extraHeaders,
    },
  });
}

// ============================================================
// APP SECURITY
// ============================================================

async function checkAppSecurity(request, env) {
  const ua = String(
    request.headers.get("User-Agent") || ""
  )
    .trim()
    .toLowerCase();

  const appKey = String(
    request.headers.get("X-App-Key") || ""
  ).trim();

  const secret = String(
    env.APP_SECRET || ""
  ).trim();

  console.log(
    JSON.stringify({
      type: "APP_SECURITY_CHECK",
      uaOk: ua.includes(NEW_UA.toLowerCase()),
      keyReceived: appKey.length > 0,
      secretConfigured: secret.length > 0,
      keyLength: appKey.length,
      secretLength: secret.length,
    })
  );

  if (!secret) {
    console.error(
      "APP SECURITY: APP_SECRET NOT CONFIGURED"
    );

    return {
      ok: false,
      status: 500,
      message: "APP_SECRET is not configured",
    };
  }

  if (!ua.includes(NEW_UA.toLowerCase())) {
    console.warn(
      "APP SECURITY: BAD USER-AGENT"
    );

    return {
      ok: false,
      status: 403,
      message: "Invalid application",
    };
  }

  if (!appKey) {
    console.warn(
      "APP SECURITY: MISSING X-App-Key"
    );

    return {
      ok: false,
      status: 403,
      message: "Missing application key",
    };
  }

  if (appKey !== secret) {
    console.warn(
      "APP SECURITY: INVALID KEY"
    );

    return {
      ok: false,
      status: 403,
      message: "Invalid application key",
    };
  }

  console.log("APP SECURITY: OK");

  return {
    ok: true,
  };
}

// ============================================================
// RATE LIMIT
// ============================================================

async function checkRateLimit(
  request,
  env,
  type = "play"
) {
  if (!env.DATA_KV) {
    return true;
  }

  try {
    const ip =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Real-IP") ||
      "unknown";

    const key =
      `ratelimit:${type}:${ip}`;

    const now = Date.now();

    const raw =
      await env.DATA_KV.get(key);

    let limit = PLAY_RATE_LIMIT;

    if (type === "invalid") {
      limit = INVALID_RATE_LIMIT;
    }

    if (type === "proxy") {
      limit = PROXY_RATE_LIMIT;
    }

    // ========================================================
    // NEW LIMIT
    // ========================================================

    if (!raw) {
      const data = {
        count: 1,
        resetAt:
          now + RATE_WINDOW * 1000,
      };

      await env.DATA_KV.put(
        key,
        JSON.stringify(data),
        {
          expirationTtl: Math.max(
            60,
            RATE_WINDOW + 5
          ),
        }
      );

      return true;
    }

    let old;

    try {
      old = JSON.parse(raw);
    } catch {
      old = null;
    }

    if (
      !old ||
      !old.resetAt ||
      typeof old.count !== "number"
    ) {
      const data = {
        count: 1,
        resetAt:
          now + RATE_WINDOW * 1000,
      };

      await env.DATA_KV.put(
        key,
        JSON.stringify(data),
        {
          expirationTtl: Math.max(
            60,
            RATE_WINDOW + 5
          ),
        }
      );

      return true;
    }

    // ========================================================
    // RESET
    // ========================================================

    if (now >= old.resetAt) {
      const data = {
        count: 1,
        resetAt:
          now + RATE_WINDOW * 1000,
      };

      await env.DATA_KV.put(
        key,
        JSON.stringify(data),
        {
          expirationTtl: Math.max(
            60,
            RATE_WINDOW + 5
          ),
        }
      );

      return true;
    }

    // ========================================================
    // LIMIT
    // ========================================================

    if (old.count >= limit) {
      console.warn(
        "RATE LIMIT:",
        JSON.stringify({
          type,
          ip,
          count: old.count,
          limit,
        })
      );

      return false;
    }

    old.count++;

    const remaining =
      Math.ceil(
        (old.resetAt - now) / 1000
      ) + 5;

    await env.DATA_KV.put(
      key,
      JSON.stringify(old),
      {
        expirationTtl: Math.max(
          60,
          remaining
        ),
      }
    );

    return true;

  } catch (error) {
    console.error(
      "RATE LIMIT ERROR:",
      error
    );

    // لا نوقف التشغيل لو حصلت مشكلة في KV
    return true;
  }
}

// ============================================================
// SECURITY GUARD
// ============================================================

async function securityGuard(
  request,
  env,
  type = "play"
) {
  const security =
    await checkAppSecurity(
      request,
      env
    );

  if (!security.ok) {
    return {
      ok: false,
      response: text(
        security.message,
        security.status
      ),
    };
  }

  const allowed =
    await checkRateLimit(
      request,
      env,
      type
    );

  if (!allowed) {
    return {
      ok: false,
      response: text(
        "Too Many Requests",
        429,
        {
          "Retry-After": "60",
        }
      ),
    };
  }

  return {
    ok: true,
  };
}

// ============================================================
// CHANNELS
// ============================================================

async function loadChannels(env) {
  // ========================================================
  // KV
  // ========================================================

  if (env.DATA_KV) {
    try {
      const value =
        await env.DATA_KV.get(
          "channels"
        );

      if (value) {
        const parsed =
          JSON.parse(value);

        if (Array.isArray(parsed)) {
          return parsed;
        }

        if (
          parsed &&
          Array.isArray(
            parsed.channels
          )
        ) {
          return parsed.channels;
        }
      }
    } catch (error) {
      console.error(
        "KV CHANNELS ERROR:",
        error
      );
    }
  }

  // ========================================================
  // ASSETS
  // ========================================================

  try {
    if (env.ASSETS) {
      const req =
        new Request(
          "https://internal.local/data/channels.json"
        );

      const response =
        await env.ASSETS.fetch(req);

      if (response.ok) {
        const data =
          await response.json();

        if (Array.isArray(data)) {
          return data;
        }

        if (
          data &&
          Array.isArray(
            data.channels
          )
        ) {
          return data.channels;
        }
      }
    }
  } catch (error) {
    console.error(
      "ASSETS CHANNELS ERROR:",
      error
    );
  }

  return [];
}

async function findChannel(
  env,
  id
) {
  const channels =
    await loadChannels(env);

  return channels.find(
    channel =>
      String(channel.id) ===
      String(id)
  );
}

// ============================================================
// URL VALIDATION
// ============================================================

function validateUpstreamURL(
  value
) {
  try {
    const url =
      new URL(value);

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    return url;

  } catch {
    return null;
  }
}

// ============================================================
// UPSTREAM HEADERS
// ============================================================

function getUpstreamHeaders(
  request,
  sourceUrl
) {
  const headers =
    new Headers();

  headers.set(
    "User-Agent",
    PROXY_UA
  );

  headers.set(
    "Accept",
    "*/*"
  );

  headers.set(
    "Accept-Language",
    "en-US,en;q=0.9"
  );

  // --------------------------------------------------------
  // Range
  // --------------------------------------------------------

  const range =
    request.headers.get(
      "Range"
    );

  if (range) {
    headers.set(
      "Range",
      range
    );
  }

  // --------------------------------------------------------
  // OSTORA
  // --------------------------------------------------------

  if (
    sourceUrl.hostname
      .toLowerCase()
      .includes("ostora")
  ) {
    headers.set(
      "Referer",
      `https://${sourceUrl.hostname}/`
    );
  }

  return headers;
}

// ============================================================
// UPSTREAM ERROR DIAGNOSTICS
// ============================================================

async function logUpstreamError(
  prefix,
  response,
  sourceUrl
) {
  let body = "";

  try {
    body = (
      await response
        .clone()
        .text()
    ).slice(0, 2000);
  } catch {
    body =
      "Unable to read upstream response body";
  }

  const headers = {};

  for (
    const [name, value]
    of response.headers
  ) {
    headers[name] = value;
  }

  console.error(
    prefix,
    JSON.stringify({
      status:
        response.status,

      statusText:
        response.statusText,

      url:
        `${sourceUrl.protocol}//` +
        `${sourceUrl.hostname}` +
        `${sourceUrl.port ? ":" + sourceUrl.port : ""}`,

      responseHeaders:
        headers,

      responseBody:
        body,
    })
  );
}

// ============================================================
// UPSTREAM FETCH
// ============================================================

async function fetchUpstream(
  request,
  sourceUrl
) {
  const headers =
    getUpstreamHeaders(
      request,
      sourceUrl
    );

  return await fetch(
    sourceUrl.toString(),
    {
      method: "GET",
      headers,
      redirect: "follow",
    }
  );
}

// ============================================================
// M3U8 DETECTION
// ============================================================

function isProbablyM3U8(
  response,
  body = ""
) {
  const contentType =
    String(
      response.headers.get(
        "Content-Type"
      ) || ""
    ).toLowerCase();

  if (
    contentType.includes(
      "mpegurl"
    ) ||
    contentType.includes(
      "vnd.apple.mpegurl"
    )
  ) {
    return true;
  }

  const trimmed =
    body.trim();

  return (
    trimmed.startsWith(
      "#EXTM3U"
    ) ||
    trimmed.includes(
      "#EXTINF"
    ) ||
    trimmed.includes(
      "#EXT-X-"
    )
  );
}

// ============================================================
// BASE64
// ============================================================

function bytesToBase64Url(
  bytes
) {
  let binary = "";

  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {
    binary += String.fromCharCode(
      bytes[i]
    );
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(
  value
) {
  const base64 =
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  const padded =
    base64 +
    "=".repeat(
      (4 -
        (base64.length % 4)) %
        4
    );

  const binary =
    atob(padded);

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
// HMAC
// ============================================================

async function hmacSign(
  value,
  secret
) {
  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(
        secret
      ),
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        value
      )
    );

  return bytesToBase64Url(
    new Uint8Array(
      signature
    )
  );
}

async function hmacVerify(
  value,
  signature,
  secret
) {
  const expected =
    await hmacSign(
      value,
      secret
    );

  if (
    expected.length !==
    signature.length
  ) {
    return false;
  }

  let result = 0;

  for (
    let i = 0;
    i < expected.length;
    i++
  ) {
    result |=
      expected.charCodeAt(i) ^
      signature.charCodeAt(i);
  }

  return result === 0;
}

// ============================================================
// HLS TOKEN
// ============================================================

async function createHLSToken(
  target,
  env
) {
  const secret =
    String(
      env.APP_SECRET || ""
    ).trim();

  if (!secret) {
    throw new Error(
      "APP_SECRET missing"
    );
  }

  const exp =
    Math.floor(
      Date.now() / 1000
    ) +
    HLS_TOKEN_TTL;

  const payload = {
    u: target,
    e: exp,
  };

  const encoded =
    bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify(
          payload
        )
      )
    );

  const signature =
    await hmacSign(
      encoded,
      secret
    );

  return (
    encoded +
    "." +
    signature
  );
}

async function verifyHLSToken(
  token,
  env
) {
  try {
    const parts =
      String(token).split(".");

    if (parts.length !== 2) {
      return null;
    }

    const encoded =
      parts[0];

    const signature =
      parts[1];

    const secret =
      String(
        env.APP_SECRET || ""
      ).trim();

    if (!secret) {
      return null;
    }

    const valid =
      await hmacVerify(
        encoded,
        signature,
        secret
      );

    if (!valid) {
      return null;
    }

    const bytes =
      base64UrlToBytes(
        encoded
      );

    const payload =
      JSON.parse(
        new TextDecoder().decode(
          bytes
        )
      );

    if (
      !payload ||
      !payload.u ||
      !payload.e
    ) {
      return null;
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    if (
      Number(payload.e) <
      now
    ) {
      return null;
    }

    return payload;

  } catch {
    return null;
  }
}

// ============================================================
// RESOLVE URL
// ============================================================

function resolveURL(
  value,
  baseUrl
) {
  try {
    return new URL(
      value,
      baseUrl
    ).toString();
  } catch {
    return value;
  }
}

// ============================================================
// REWRITE URI
// ============================================================

async function rewriteURIAttributes(
  line,
  baseUrl,
  env
) {
  const regex =
    /URI="([^"]+)"/gi;

  let output = line;

  const matches = [
    ...line.matchAll(regex),
  ];

  for (
    const match of matches
  ) {
    const original =
      match[1];

    if (
      !original ||
      original.startsWith(
        "data:"
      )
    ) {
      continue;
    }

    const absolute =
      resolveURL(
        original,
        baseUrl
      );

    const token =
      await createHLSToken(
        absolute,
        env
      );

    const proxied =
      `/api/hls?token=${encodeURIComponent(
        token
      )}`;

    output =
      output.replace(
        match[0],
        `URI="${proxied}"`
      );
  }

  return output;
}

// ============================================================
// REWRITE MANIFEST
// ============================================================

async function rewriteHLSManifest(
  body,
  sourceUrl,
  env
) {
  const lines =
    body.split(/\r?\n/);

  const result = [];

  for (
    const line of lines
  ) {
    const trimmed =
      line.trim();

    if (!trimmed) {
      result.push(line);
      continue;
    }

    // ========================================================
    // URI داخل EXT-X
    // ========================================================

    if (
      trimmed.startsWith("#") &&
      trimmed.includes("URI=")
    ) {
      result.push(
        await rewriteURIAttributes(
          line,
          sourceUrl,
          env
        )
      );

      continue;
    }

    // ========================================================
    // Comments
    // ========================================================

    if (
      trimmed.startsWith("#")
    ) {
      result.push(line);
      continue;
    }

    // ========================================================
    // Segment / Playlist
    // ========================================================

    const absolute =
      resolveURL(
        trimmed,
        sourceUrl
      );

    const token =
      await createHLSToken(
        absolute,
        env
      );

    const proxied =
      `/api/hls?token=${encodeURIComponent(
        token
      )}`;

    const indent =
      line.match(
        /^\s*/
      )?.[0] || "";

    result.push(
      indent + proxied
    );
  }

  return result.join("\n");
}

// ============================================================
// PLAY API
// ============================================================

async function playApi(
  request,
  env,
  ctx
) {
  const security =
    await securityGuard(
      request,
      env,
      "play"
    );

  if (!security.ok) {
    return security.response;
  }

  const url =
    new URL(request.url);

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

  const channel =
    await findChannel(
      env,
      id
    );

  if (!channel) {
    console.warn(
      "CHANNEL NOT FOUND:",
      id
    );

    return text(
      "Channel not found",
      404
    );
  }

  let source =
    channel.url ||
    channel.stream ||
    channel.source ||
    channel.body ||
    channel.link;

  if (!source) {
    source =
      FALLBACK_VIDEO;
  }

  const sourceUrl =
    validateUpstreamURL(
      source
    );

  if (!sourceUrl) {
    console.error(
      "INVALID UPSTREAM URL:",
      source
    );

    return text(
      "Invalid upstream URL",
      400
    );
  }

  console.log(
    JSON.stringify({
      type:
        "UPSTREAM_REQUEST",

      channel:
        String(id),

      protocol:
        sourceUrl.protocol,

      host:
        sourceUrl.hostname,

      port:
        sourceUrl.port ||
        (
          sourceUrl.protocol ===
          "https:"
            ? "443"
            : "80"
        ),
    })
  );

  try {
    const response =
      await fetchUpstream(
        request,
        sourceUrl
      );

    if (!response.ok) {
      await logUpstreamError(
        "PLAY UPSTREAM ERROR:",
        response,
        sourceUrl
      );

      return text(
        `Upstream error: ${response.status}`,
        response.status
      );
    }

    const contentType =
      response.headers.get(
        "Content-Type"
      ) || "";

    const body =
      await response.text();

    const isM3U8 =
      isProbablyM3U8(
        new Response(body, {
          headers: {
            "Content-Type":
              contentType,
          },
        }),
        body
      );

    // ========================================================
    // NOT M3U8
    // ========================================================

    if (!isM3U8) {
      return new Response(
        body,
        {
          status: 200,
          headers: {
            "Content-Type":
              contentType ||
              "application/octet-stream",

            "Cache-Control":
              "no-store",

            "Access-Control-Allow-Origin":
              "*",
          },
        }
      );
    }

    // ========================================================
    // M3U8
    // ========================================================

    const rewritten =
      await rewriteHLSManifest(
        body,
        sourceUrl,
        env
      );

    // ========================================================
    // VIEWER
    // ========================================================

    if (ctx) {
      ctx.waitUntil(
        incrementViewer(
          env,
          String(id)
        )
      );
    }

    return new Response(
      rewritten,
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.apple.mpegurl",

          "Cache-Control":
            "no-store, no-cache, must-revalidate",

          "Pragma":
            "no-cache",

          "Access-Control-Allow-Origin":
            "*",
        },
      }
    );

  } catch (error) {
    console.error(
      "PLAY FETCH ERROR:",
      error
    );

    return text(
      "Unable to fetch upstream",
      502
    );
  }
}

// ============================================================
// HLS API
// ============================================================

async function hlsApi(
  request,
  env,
  ctx
) {
  const url =
    new URL(request.url);

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

  const payload =
    await verifyHLSToken(
      token,
      env
    );

  if (!payload) {
    return text(
      "Invalid or expired token",
      403
    );
  }

  const target =
    validateUpstreamURL(
      payload.u
    );

  if (!target) {
    return text(
      "Invalid target",
      400
    );
  }

  try {
    const response =
      await fetchUpstream(
        request,
        target
      );

    if (!response.ok) {
      await logUpstreamError(
        "HLS UPSTREAM ERROR:",
        response,
        target
      );

      return text(
        `Upstream error: ${response.status}`,
        response.status
      );
    }

    const contentType =
      response.headers.get(
        "Content-Type"
      ) || "";

    const looksLikePlaylist =
      contentType
        .toLowerCase()
        .includes(
          "mpegurl"
        ) ||
      contentType
        .toLowerCase()
        .includes(
          "vnd.apple.mpegurl"
        );

    // ========================================================
    // PLAYLIST
    // ========================================================

    if (looksLikePlaylist) {
      const body =
        await response.text();

      const rewritten =
        await rewriteHLSManifest(
          body,
          target,
          env
        );

      return new Response(
        rewritten,
        {
          status: 200,
          headers: {
            "Content-Type":
              "application/vnd.apple.mpegurl",

            "Cache-Control":
              "no-store",

            "Access-Control-Allow-Origin":
              "*",
          },
        }
      );
    }

    // ========================================================
    // SEGMENT
    // ========================================================

    const headers =
      new Headers();

    headers.set(
      "Content-Type",
      contentType ||
        "application/octet-stream"
    );

    headers.set(
      "Cache-Control",
      "no-store"
    );

    headers.set(
      "Access-Control-Allow-Origin",
      "*"
    );

    const contentLength =
      response.headers.get(
        "Content-Length"
      );

    if (contentLength) {
      headers.set(
        "Content-Length",
        contentLength
      );
    }

    return new Response(
      response.body,
      {
        status:
          response.status,

        headers,
      }
    );

  } catch (error) {
    console.error(
      "HLS ERROR:",
      error
    );

    return text(
      "HLS proxy error",
      502
    );
  }
}

// ============================================================
// PLAYLIST API
// ============================================================

async function playlistApi(
  request,
  env
) {
  const security =
    await securityGuard(
      request,
      env,
      "play"
    );

  if (!security.ok) {
    return security.response;
  }

  const channels =
    await loadChannels(env);

  const origin =
    new URL(
      request.url
    ).origin;

  const lines = [
    "#EXTM3U",
  ];

  for (
    const channel of channels
  ) {
    const id =
      channel.id;

    const name =
      channel.name ||
      channel.title ||
      channel.channel_name ||
      `Channel ${id}`;

    const logo =
      channel.logo ||
      channel.image ||
      "";

    const group =
      channel.category ||
      "SUPER TV";

    let info =
      "#EXTINF:-1";

    if (logo) {
      info +=
        ` tvg-logo="${logo}"`;
    }

    info +=
      ` group-title="${group}",${name}`;

    lines.push(info);

    lines.push(
      `${origin}/api/play.m3u8?id=${encodeURIComponent(
        id
      )}`
    );
  }

  return new Response(
    lines.join("\n") +
      "\n",
    {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.apple.mpegurl",

        "Cache-Control":
          "no-store",

        "Access-Control-Allow-Origin":
          "*",
      },
    }
  );
}

// ============================================================
// GENERIC M3U8 PROXY
// ============================================================

async function proxyM3u8Api(
  request,
  env
) {
  const security =
    await securityGuard(
      request,
      env,
      "proxy"
    );

  if (!security.ok) {
    return security.response;
  }

  const url =
    new URL(request.url);

  const targetValue =
    url.searchParams.get(
      "url"
    );

  if (!targetValue) {
    return text(
      "Missing url",
      400
    );
  }

  const target =
    validateUpstreamURL(
      targetValue
    );

  if (!target) {
    return text(
      "Invalid url",
      400
    );
  }

  try {
    const response =
      await fetchUpstream(
        request,
        target
      );

    if (!response.ok) {
      await logUpstreamError(
        "PROXY UPSTREAM ERROR:",
        response,
        target
      );

      return text(
        `Upstream error: ${response.status}`,
        response.status
      );
    }

    const body =
      await response.text();

    if (
      isProbablyM3U8(
        response,
        body
      )
    ) {
      const rewritten =
        await rewriteHLSManifest(
          body,
          target,
          env
        );

      return new Response(
        rewritten,
        {
          status: 200,
          headers: {
            "Content-Type":
              "application/vnd.apple.mpegurl",

            "Cache-Control":
              "no-store",

            "Access-Control-Allow-Origin":
              "*",
          },
        }
      );
    }

    return new Response(
      body,
      {
        status: 200,
        headers: {
          "Content-Type":
            response.headers.get(
              "Content-Type"
            ) ||
            "application/octet-stream",

          "Cache-Control":
            "no-store",

          "Access-Control-Allow-Origin":
            "*",
        },
      }
    );

  } catch (error) {
    console.error(
      "PROXY ERROR:",
      error
    );

    return text(
      "Proxy error",
      502
    );
  }
}

// ============================================================
// TS / VIDEO PROXY
// ============================================================

async function tsApi(
  request,
  env
) {
  const security =
    await securityGuard(
      request,
      env,
      "proxy"
    );

  if (!security.ok) {
    return security.response;
  }

  const url =
    new URL(request.url);

  const targetValue =
    url.searchParams.get(
      "url"
    );

  if (!targetValue) {
    return text(
      "Missing url",
      400
    );
  }

  const target =
    validateUpstreamURL(
      targetValue
    );

  if (!target) {
    return text(
      "Invalid url",
      400
    );
  }

  try {
    const response =
      await fetchUpstream(
        request,
        target
      );

    if (!response.ok) {
      await logUpstreamError(
        "TS UPSTREAM ERROR:",
        response,
        target
      );

      return text(
        `Upstream error: ${response.status}`,
        response.status
      );
    }

    const headers =
      new Headers();

    headers.set(
      "Content-Type",
      response.headers.get(
        "Content-Type"
      ) ||
        "video/mp2t"
    );

    headers.set(
      "Cache-Control",
      "no-store"
    );

    headers.set(
      "Access-Control-Allow-Origin",
      "*"
    );

    const length =
      response.headers.get(
        "Content-Length"
      );

    if (length) {
      headers.set(
        "Content-Length",
        length
      );
    }

    return new Response(
      response.body,
      {
        status:
          response.status,

        headers,
      }
    );

  } catch (error) {
    console.error(
      "TS ERROR:",
      error
    );

    return text(
      "TS proxy error",
      502
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
  const security =
    await securityGuard(
      request,
      env,
      "play"
    );

  if (!security.ok) {
    return security.response;
  }

  const channels =
    await loadChannels(env);

  const safeChannels =
    channels.map(
      channel => {
        const copy = {
          ...channel,
        };

        delete copy.url;
        delete copy.stream;
        delete copy.source;
        delete copy.body;
        delete copy.link;

        return copy;
      }
    );

  return jsonResponse({
    ok: true,
    count:
      safeChannels.length,
    channels:
      safeChannels,
  });
}

// ============================================================
// SAVE
// ============================================================

async function saveApi(
  request,
  env
) {
  const security =
    await checkAppSecurity(
      request,
      env
    );

  if (!security.ok) {
    return text(
      security.message,
      security.status
    );
  }

  if (
    request.method !==
    "POST"
  ) {
    return text(
      "POST required",
      405
    );
  }

  if (!env.DATA_KV) {
    return text(
      "DATA_KV is not configured",
      500
    );
  }

  try {
    const body =
      await request.json();

    let channels;

    if (
      Array.isArray(body)
    ) {
      channels = body;
    } else if (
      body &&
      Array.isArray(
        body.channels
      )
    ) {
      channels =
        body.channels;
    } else {
      return text(
        "Invalid channels data",
        400
      );
    }

    await env.DATA_KV.put(
      "channels",
      JSON.stringify(
        channels
      )
    );

    return jsonResponse({
      ok: true,
      saved:
        channels.length,
    });

  } catch (error) {
    console.error(
      "SAVE ERROR:",
      error
    );

    return jsonResponse(
      {
        ok: false,
        error:
          String(
            error?.message ||
              error
          ),
      },
      500
    );
  }
}

// ============================================================
// VIEWERS
// ============================================================

async function incrementViewer(
  env,
  channelId
) {
  if (!env.DATA_KV) {
    return;
  }

  const key =
    `viewer:${channelId}`;

  const now =
    Date.now();

  try {
    const raw =
      await env.DATA_KV.get(
        key
      );

    let viewers = [];

    if (raw) {
      try {
        viewers =
          JSON.parse(raw);
      } catch {
        viewers = [];
      }
    }

    if (
      !Array.isArray(viewers)
    ) {
      viewers = [];
    }

    viewers =
      viewers.filter(
        timestamp =>
          now -
            Number(timestamp) <
          30000
      );

    viewers.push(now);

    await env.DATA_KV.put(
      key,
      JSON.stringify(
        viewers
      ),
      {
        expirationTtl: 60,
      }
    );

  } catch (error) {
    console.error(
      "VIEWER INCREMENT ERROR:",
      error
    );
  }
}

async function getViewerCount(
  env,
  channelId
) {
  if (!env.DATA_KV) {
    return 0;
  }

  const key =
    `viewer:${channelId}`;

  try {
    const raw =
      await env.DATA_KV.get(
        key
      );

    if (!raw) {
      return 0;
    }

    let viewers;

    try {
      viewers =
        JSON.parse(raw);
    } catch {
      return 0;
    }

    if (
      !Array.isArray(viewers)
    ) {
      return 0;
    }

    const now =
      Date.now();

    viewers =
      viewers.filter(
        timestamp =>
          now -
            Number(timestamp) <
          30000
      );

    return viewers.length;

  } catch (error) {
    console.error(
      "GET VIEWERS ERROR:",
      error
    );

    return 0;
  }
}

// ============================================================
// VIEWERS API
// ============================================================

async function viewersApi(
  request,
  env
) {
  const security =
    await securityGuard(
      request,
      env,
      "play"
    );

  if (!security.ok) {
    return security.response;
  }

  const url =
    new URL(request.url);

  const id =
    url.searchParams.get(
      "id"
    );

  if (id) {
    const count =
      await getViewerCount(
        env,
        id
      );

    return jsonResponse({
      ok: true,
      id,
      viewers: count,
    });
  }

  const channels =
    await loadChannels(env);

  const result = {};

  for (
    const channel of channels
  ) {
    result[
      String(channel.id)
    ] =
      await getViewerCount(
        env,
        String(channel.id)
      );
  }

  return jsonResponse({
    ok: true,
    viewers: result,
  });
}

// ============================================================
// ADMIN
// ============================================================

async function adminApi(
  request,
  env
) {
  const security =
    await checkAppSecurity(
      request,
      env
    );

  if (!security.ok) {
    return text(
      security.message,
      security.status
    );
  }

  const channels =
    await loadChannels(env);

  return jsonResponse({
    ok: true,
    worker:
      "super-tv-api",

    channels:
      channels.length,

    kv:
      Boolean(env.DATA_KV),

    assets:
      Boolean(env.ASSETS),

    time:
      new Date().toISOString(),
  });
}
