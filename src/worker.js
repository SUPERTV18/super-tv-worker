// ============================================================
// SUPER TV API - Cloudflare Worker
// HLS SOURCE HIDDEN PROXY
// HTTP + HTTPS SOURCE SUPPORT
// ============================================================

const NEW_UA = "stv2026";
const OLD_UA = "2026stv";

const FALLBACK_VIDEO =
  "https://github.com/himasabry/video/raw/refs/heads/main/output.m3u8";

// User-Agent المرسل إلى السيرفرات الأصلية
const PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

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
// RESPONSE HELPERS
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
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
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      }
    }
  );
}

// ============================================================
// GET CLIENT IP
// ============================================================

function getClientIP(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
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
    new TextEncoder().encode(value);

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
// BASE64URL
// ============================================================

function base64UrlEncode(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  value = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (value.length % 4) {
    value += "=";
  }

  const binary = atob(value);

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
    ["sign", "verify"]
  );
}

// ============================================================
// CREATE HLS TOKEN
// ============================================================

async function createHLSToken(
  env,
  target
) {
  const expires =
    Date.now() +
    HLS_TOKEN_TTL;

  const payload =
    JSON.stringify({
      u: target,
      e: expires
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
    await getCryptoKey(env);

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

  return `${payload64}.${sig64}`;
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
      await getCryptoKey(env);

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
      url: payload.u,
      expires: payload.e
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
// RATE LIMIT
// ============================================================

async function checkRateLimit(
  env,
  key,
  limit,
  windowSeconds
) {
  if (!env.DATA_KV) {
    return {
      allowed: true,
      remaining: limit
    };
  }

  const now =
    Date.now();

  const storageKey =
    `ratelimit:${key}`;

  try {
    const old =
      await env.DATA_KV.get(
        storageKey,
        "json"
      );

    if (
      !old ||
      !old.resetAt ||
      old.resetAt <= now
    ) {
      await env.DATA_KV.put(
        storageKey,
        JSON.stringify({
          count: 1,
          resetAt:
            now +
            windowSeconds * 1000
        }),
        {
          expirationTtl:
            windowSeconds + 5
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
      old.count >=
      limit
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

    await env.DATA_KV.put(
      storageKey,
      JSON.stringify(old),
      {
        expirationTtl:
          Math.max(
            1,
            Math.ceil(
              (
                old.resetAt -
                now
              ) / 1000
            ) + 5
          )
      }
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

  } catch (e) {
    console.error(
      "RATE LIMIT ERROR:",
      e
    );

    return {
      allowed: true,
      remaining: limit
    };
  }
}

// ============================================================
// APP SECURITY
// ============================================================

async function checkAppSecurity(
  request,
  env
) {
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
      NEW_UA.toLowerCase()
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
  // INVALID
  // ==========================================================

  if (
    !security.allowed
  ) {
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
// LOAD CHANNELS
// ============================================================

async function loadChannels(
  env
) {
  if (env.DATA_KV) {
    try {
      const kvData =
        await env.DATA_KV.get(
          "channels",
          "json"
        );

      if (kvData) {
        return kvData;
      }

    } catch (e) {
      console.error(
        "KV CHANNELS ERROR:",
        e
      );
    }
  }

  if (env.ASSETS) {
    try {
      const response =
        await env.ASSETS.fetch(
          new Request(
            new URL(
              "/data/channels.json",
              "https://internal.local"
            )
          )
        );

      if (response.ok) {
        return await response.json();
      }

    } catch (e) {
      console.error(
        "ASSETS CHANNELS ERROR:",
        e
      );
    }
  }

  throw new Error(
    "channels.json not found"
  );
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
// VALIDATE UPSTREAM URL
// ============================================================

function validateUpstreamURL(
  target
) {
  try {
    const parsed =
      new URL(target);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return null;
    }

    return parsed;

  } catch {
    return null;
  }
}

// ============================================================
// BUILD UPSTREAM HEADERS
// ============================================================

function getUpstreamHeaders(
  target
) {
  const headers =
    new Headers();

  headers.set(
    "User-Agent",
    PROXY_UA
  );

  // مهم لمصادر IPTV / HLS
  headers.set(
    "Accept",
    "*/*"
  );

  try {
    const parsed =
      new URL(target);

    if (
      parsed.hostname
        .toLowerCase()
        .includes("ostora")
    ) {
      headers.set(
        "Referer",
        "https://ostora.pages.dev/"
      );
    }

  } catch {}

  return headers;
}

// ============================================================
// FETCH UPSTREAM
// ============================================================

async function fetchUpstream(
  target,
  request
) {
  const parsed =
    validateUpstreamURL(
      target
    );

  if (!parsed) {
    throw new Error(
      "Invalid HTTP/HTTPS upstream URL"
    );
  }

  const headers =
    getUpstreamHeaders(
      parsed.toString()
    );

  // مهم للفيديو والـ segments
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

  /*
    لا نرسل Referer الخاص بالـ Worker
    إلى السيرفر الأصلي.
  */

  return fetch(
    parsed.toString(),
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
// HLS DETECTION
// ============================================================

function isProbablyM3U8(
  url,
  contentType = ""
) {
  const lowerUrl =
    String(url || "")
      .toLowerCase();

  const lowerType =
    String(contentType || "")
      .toLowerCase();

  return (
    lowerType.includes(
      "mpegurl"
    ) ||
    lowerType.includes(
      "vnd.apple.mpegurl"
    ) ||
    lowerUrl.includes(
      ".m3u8"
    ) ||
    lowerUrl.includes(
      "m3u8?"
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
  workerOrigin
) {
  const lines =
    body.split(/\r?\n/);

  const output = [];

  for (
    let line of lines
  ) {
    const original =
      line.trim();

    // --------------------------------------------------------
    // URI="..." داخل EXT-X-KEY / EXT-X-MAP / MEDIA ...
    // --------------------------------------------------------

    if (
      original.startsWith("#")
    ) {
      line =
        await rewriteURIAttributes(
          env,
          line,
          sourceUrl,
          workerOrigin
        );

      output.push(
        line
      );

      continue;
    }

    // --------------------------------------------------------
    // فارغ
    // --------------------------------------------------------

    if (!original) {
      output.push(
        line
      );

      continue;
    }

    // --------------------------------------------------------
    // URL segment / child playlist
    // --------------------------------------------------------

    try {
      const absolute =
        new URL(
          original,
          sourceUrl
        ).toString();

      const token =
        await createHLSToken(
          env,
          absolute
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

  return output.join("\n");
}

// ============================================================
// REWRITE URI ATTRIBUTES
// ============================================================

async function rewriteURIAttributes(
  env,
  line,
  sourceUrl,
  workerOrigin
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

  // نعالج من الخلف للأمام
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
          absolute
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
  // ----------------------------------------------------------
  // Security
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // Token
  // ----------------------------------------------------------

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

  const target =
    decoded.url;

  // ----------------------------------------------------------
  // Validate HTTP / HTTPS
  // ----------------------------------------------------------

  const targetUrl =
    validateUpstreamURL(
      target
    );

  if (!targetUrl) {
    return text(
      "Invalid upstream URL",
      400
    );
  }

  // ----------------------------------------------------------
  // Fetch
  // ----------------------------------------------------------

  try {
    const upstream =
      await fetchUpstream(
        targetUrl.toString(),
        request
      );

    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "";

    // --------------------------------------------------------
    // HLS Manifest
    // --------------------------------------------------------

    if (
      isProbablyM3U8(
        targetUrl.toString(),
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
            targetUrl.toString(),
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
              "no-store",

            "X-Content-Type-Options":
              "nosniff"
          }
        }
      );
    }

    // --------------------------------------------------------
    // Segment / Key / Binary
    // --------------------------------------------------------

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
      "HLS Proxy Error: " +
        e.message,
      502
    );
  }
}

// ============================================================
// PLAY M3U8
// ============================================================

async function playApi(
  request,
  env,
  url
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

    // --------------------------------------------------------
    // OLD UA
    // --------------------------------------------------------

    const ua =
      request.headers.get(
        "User-Agent"
      ) || "";

    const lowerUA =
      ua.toLowerCase();

    if (
      lowerUA.includes(
        OLD_UA.toLowerCase()
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

    // --------------------------------------------------------
    // SECURITY
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // VIEWER
    // --------------------------------------------------------

    await incrementViewer(
      env,
      id
    );

    // --------------------------------------------------------
    // CHANNELS
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // SOURCE
    // --------------------------------------------------------

    const cleanUrl =
      channel.url
        .split("#")[0]
        .trim();

    // --------------------------------------------------------
    // IMPORTANT:
    // دعم HTTP و HTTPS
    // بما في ذلك :8080
    // --------------------------------------------------------

    const sourceUrl =
      validateUpstreamURL(
        cleanUrl
      );

    if (!sourceUrl) {
      return text(
        "Invalid channel URL. Only HTTP and HTTPS are supported.",
        400
      );
    }

    // --------------------------------------------------------
    // FETCH SOURCE
    // --------------------------------------------------------

    const headers =
      getUpstreamHeaders(
        sourceUrl.toString()
      );

    const response =
      await fetch(
        sourceUrl.toString(),
        {
          method: "GET",

          redirect:
            "follow",

          headers
        }
      );

    // --------------------------------------------------------
    // UPSTREAM ERROR
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // M3U8 SOURCE
    // --------------------------------------------------------

    if (
      isProbablyM3U8(
        response.url ||
          sourceUrl.toString(),
        contentType
      )
    ) {
      const body =
        await response.text();

      const rewritten =
        await rewriteHLSManifest(
          env,
          body,
          response.url ||
            sourceUrl.toString(),
          url.origin
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

    // --------------------------------------------------------
    // NON M3U8 SOURCE
    // --------------------------------------------------------

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
      502
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
        data[category];

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

  if (
    !validateUpstreamURL(
      target
    )
  ) {
    return text(
      "Invalid upstream URL",
      400
    );
  }

  try {
    const upstream =
      await fetchUpstream(
        target,
        request
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
      "Proxy error: " +
        e.message,
      502
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

  if (
    !validateUpstreamURL(
      target
    )
  ) {
    return text(
      "Invalid upstream URL",
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
      "TS Proxy Error: " +
        e.message,
      502
    );
  }
}

// ============================================================
// SAVE API
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
// VIEWER INCREMENT
// ============================================================

async function incrementViewer(
  env,
  id
) {
  if (!env.DATA_KV) {
    return;
  }

  const key =
    `viewer:${id}`;

  try {
    const old =
      await env.DATA_KV.get(
        key,
        "json"
      );

    const count =
      old?.count || 0;

    await env.DATA_KV.put(
      key,
      JSON.stringify({
        count:
          count + 1,

        lastActivity:
          Date.now()
      }),
      {
        expirationTtl:
          31
      }
    );

  } catch (e) {
    console.error(
      "VIEWER INCREMENT ERROR:",
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

  if (!env.DATA_KV) {
    return json({
      [id]: 0
    });
  }

  try {
    const data =
      await env.DATA_KV.get(
        `viewer:${id}`,
        "json"
      );

    return json({
      [id]:
        data?.count || 0
    });

  } catch {
    return json({
      [id]: 0
    });
  }
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

export default {

  async fetch(
    request,
    env
  ) {
    const url =
      new URL(
        request.url
      );

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
