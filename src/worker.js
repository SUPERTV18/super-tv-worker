// ============================================================
// SUPER TV API - CLOUDFLARE WORKER
// HLS SOURCE HIDDEN PROXY
// ============================================================

const NEW_UA = "stv2026";
const OLD_UA = "2026stv";

const FALLBACK_VIDEO =
  "https://github.com/himasabry/video/raw/refs/heads/main/output.m3u8";

const PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/148.0.0.0 Safari/537.36";

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
// CLIENT IP
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
  const data = new TextEncoder().encode(value);

  const hash = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  return Array.from(new Uint8Array(hash))
    .map(
      b =>
        b
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}

// ============================================================
// BASE64 URL
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

  const bytes = new Uint8Array(
    binary.length
  );

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
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

    if (parts.length !== 2) {
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
        base64UrlDecode(sig64),
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

  const now = Date.now();

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
            Math.max(
              60,
              windowSeconds + 5
            )
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

    await env.DATA_KV.put(
      storageKey,
      JSON.stringify(old),
      {
        expirationTtl:
          Math.max(
            60,
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
          limit - old.count
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

  console.log(
    JSON.stringify({
      type: "APP_SECURITY_CHECK",
      uaOk:
        ua.includes(
          NEW_UA.toLowerCase()
        ),
      keyReceived:
        Boolean(appKey),
      secretConfigured:
        Boolean(env.APP_SECRET),
      keyLength:
        appKey.length,
      secretLength:
        env.APP_SECRET
          ? env.APP_SECRET.length
          : 0
    })
  );

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

  console.log(
    "APP SECURITY: OK"
  );

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
    getClientIP(request);

  const security =
    await checkAppSecurity(
      request,
      env
    );

  if (!security.allowed) {
    const ipHash =
      await sha256(ip);

    const invalidLimit =
      await checkRateLimit(
        env,
        `invalid:${ipHash}`,
        INVALID_RATE_LIMIT,
        INVALID_RATE_WINDOW
      );

    if (!invalidLimit.allowed) {
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

    if (!rate.allowed) {
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
// NORMALIZE CHANNELS
// ============================================================

function normalizeChannels(data) {
  if (!data) {
    return [];
  }

  // --------------------------------------------
  // Array مباشرة
  // --------------------------------------------

  if (Array.isArray(data)) {
    return data.filter(
      item =>
        item &&
        typeof item === "object" &&
        item.id !== undefined
    );
  }

  // --------------------------------------------
  // { channels: [...] }
  // --------------------------------------------

  if (
    Array.isArray(
      data.channels
    )
  ) {
    return data.channels.filter(
      item =>
        item &&
        typeof item === "object" &&
        item.id !== undefined
    );
  }

  // --------------------------------------------
  // تصنيفات:
  //
  // {
  //   sports: [...],
  //   movies: [...],
  //   series: [...]
  // }
  // --------------------------------------------

  const result = [];

  for (
    const value of Object.values(data)
  ) {
    if (
      Array.isArray(value)
    ) {
      for (
        const item of value
      ) {
        if (
          item &&
          typeof item === "object" &&
          item.id !== undefined
        ) {
          result.push(item);
        }
      }
    }
  }

  return result;
}

// ============================================================
// LOAD CHANNELS FROM KV
// ============================================================

async function loadChannelsFromKV(
  env
) {
  if (!env.DATA_KV) {
    return null;
  }

  try {
    const data =
      await env.DATA_KV.get(
        "channels",
        "json"
      );

    if (!data) {
      console.log(
        "KV CHANNELS: EMPTY"
      );

      return null;
    }

    const channels =
      normalizeChannels(data);

    console.log(
      "KV CHANNELS COUNT:",
      channels.length
    );

    return data;

  } catch (e) {
    console.error(
      "KV CHANNELS ERROR:",
      e
    );

    return null;
  }
}

// ============================================================
// LOAD CHANNELS FROM ASSETS
// ============================================================

async function loadChannelsFromAssets(
  env
) {
  if (!env.ASSETS) {
    return null;
  }

  const paths = [
    "/data/channels.json",
    "/channels.json"
  ];

  for (
    const path of paths
  ) {
    try {
      const response =
        await env.ASSETS.fetch(
          new Request(
            new URL(
              path,
              "https://internal.local"
            )
          )
        );

      if (
        response.ok
      ) {
        const data =
          await response.json();

        const channels =
          normalizeChannels(data);

        console.log(
          "ASSETS CHANNELS FOUND:",
          path,
          "COUNT:",
          channels.length
        );

        return data;
      }

      console.log(
        "ASSETS CHANNELS MISS:",
        path,
        response.status
      );

    } catch (e) {
      console.error(
        "ASSETS CHANNELS ERROR:",
        path,
        e
      );
    }
  }

  return null;
}

// ============================================================
// FIND CHANNEL
// ============================================================

async function findChannel(
  env,
  id
) {
  const wanted =
    String(id);

  // --------------------------------------------
  // KV
  // --------------------------------------------

  const kvData =
    await loadChannelsFromKV(
      env
    );

  const kvChannels =
    normalizeChannels(
      kvData
    );

  const kvFound =
    kvChannels.find(
      channel =>
        String(
          channel.id
        ) === wanted
    );

  if (kvFound) {
    console.log(
      "CHANNEL_FOUND source: KV",
      wanted
    );

    return {
      channel: kvFound,
      source: "KV"
    };
  }

  // --------------------------------------------
  // ASSETS
  // --------------------------------------------

  const assetData =
    await loadChannelsFromAssets(
      env
    );

  const assetChannels =
    normalizeChannels(
      assetData
    );

  const assetFound =
    assetChannels.find(
      channel =>
        String(
          channel.id
        ) === wanted
    );

  if (assetFound) {
    console.log(
      "CHANNEL_FOUND source: ASSETS",
      wanted
    );

    return {
      channel: assetFound,
      source: "ASSETS"
    };
  }

  // --------------------------------------------
  // DIAGNOSTIC
  // --------------------------------------------

  console.warn(
    "CHANNEL_LOOKUP",
    JSON.stringify({
      requestedId: wanted,

      kvCount:
        kvChannels.length,

      assetCount:
        assetChannels.length,

      kvIds:
        kvChannels
          .slice(0, 100)
          .map(
            c =>
              String(c.id)
          ),

      assetIds:
        assetChannels
          .slice(0, 100)
          .map(
            c =>
              String(c.id)
          )
    })
  );

  return null;
}

// ============================================================
// COMPATIBLE LOAD CHANNELS
// ============================================================

async function loadChannels(
  env
) {
  const kvData =
    await loadChannelsFromKV(
      env
    );

  if (kvData) {
    return kvData;
  }

  const assetData =
    await loadChannelsFromAssets(
      env
    );

  if (assetData) {
    return assetData;
  }

  throw new Error(
    "channels.json not found in KV or Assets"
  );
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
      "channels"
    );

  if (
    !security.allowed
  ) {
    return security.response;
  }

  try {
    const data =
      await loadChannels(
        env
      );

    return json(data);

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
// UPSTREAM HEADERS
// ============================================================

function getUpstreamHeaders(
  target
) {
  const headers = {
    "User-Agent":
      PROXY_UA,
    "Accept":
      "*/*"
  };

  try {
    const parsed =
      new URL(target);

    if (
      parsed.hostname
        .toLowerCase()
        .includes("ostora")
    ) {
      headers.Referer =
        "https://ostora.pages.dev/";
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
  const headers =
    getUpstreamHeaders(
      target
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
// M3U8 DETECTION
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

    // --------------------------------------------
    // Tags
    // --------------------------------------------

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

      output.push(line);
      continue;
    }

    // --------------------------------------------
    // Empty
    // --------------------------------------------

    if (!original) {
      output.push(line);
      continue;
    }

    // --------------------------------------------
    // Segment / Playlist
    // --------------------------------------------

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
      output.push(line);
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

  const matches = [
    ...line.matchAll(regex)
  ];

  if (!matches.length) {
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
// HLS API
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

  let targetUrl;

  try {
    targetUrl =
      new URL(
        decoded.url
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
    const upstream =
      await fetchUpstream(
        targetUrl.toString(),
        request
      );

    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "";

    // --------------------------------------------
    // HLS Manifest
    // --------------------------------------------

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

    // --------------------------------------------
    // Segment / Key / Binary
    // --------------------------------------------

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

    // --------------------------------------------
    // OLD APP
    // --------------------------------------------

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

    // --------------------------------------------
    // SECURITY
    // --------------------------------------------

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

    // --------------------------------------------
    // VIEWER
    // --------------------------------------------

    await incrementViewer(
      env,
      id
    );

    // --------------------------------------------
    // FIND CHANNEL
    // --------------------------------------------

    const result =
      await findChannel(
        env,
        id
      );

    if (!result) {
      console.warn(
        "CHANNEL NOT FOUND:",
        id
      );

      return text(
        "Channel not found",
        404
      );
    }

    const channel =
      result.channel;

    console.log(
      "PLAY CHANNEL:",
      JSON.stringify({
        id: String(channel.id),
        source: result.source,
        name:
          channel.name ||
          channel.title ||
          "",
        hasUrl:
          Boolean(channel.url)
      })
    );

    if (!channel.url) {
      return text(
        "Channel URL missing",
        404
      );
    }

    // --------------------------------------------
    // SOURCE
    // --------------------------------------------

    const cleanUrl =
      String(channel.url)
        .split("#")[0]
        .trim();

    console.log(
      "UPSTREAM REQUEST:",
      JSON.stringify({
        channel:
          String(channel.id),
        protocol:
          (() => {
            try {
              return new URL(
                cleanUrl
              ).protocol;
            } catch {
              return "";
            }
          })(),
        host:
          (() => {
            try {
              return new URL(
                cleanUrl
              ).hostname;
            } catch {
              return "";
            }
          })(),
        port:
          (() => {
            try {
              return new URL(
                cleanUrl
              ).port;
            } catch {
              return "";
            }
          })()
      })
    );

    // --------------------------------------------
    // FETCH SOURCE
    // --------------------------------------------

    const response =
      await fetchUpstream(
        cleanUrl,
        request
      );

    console.log(
      "UPSTREAM RESPONSE:",
      JSON.stringify({
        channel:
          String(channel.id),
        status:
          response.status,
        finalUrl:
          response.url
      })
    );

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

    // --------------------------------------------
    // M3U8
    // --------------------------------------------

    if (
      isProbablyM3U8(
        response.url ||
          cleanUrl,
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
            cleanUrl,
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

    // --------------------------------------------
    // NON M3U8
    // --------------------------------------------

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

    const channels =
      normalizeChannels(
        data
      );

    let m3u =
      "#EXTM3U\n";

    const host =
      url.origin;

    for (
      const ch of channels
    ) {
      const name =
        ch.name ||
        ch.title ||
        ch.channel_name ||
        ch.id;

      m3u +=
        `#EXTINF:-1 tvg-id="${ch.id}",${name}\n`;

      m3u +=
        `${host}/api/play.m3u8?id=${encodeURIComponent(ch.id)}\n`;
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
// PROXY M3U8
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
      "Proxy error",
      500
    );
  }
}

// ============================================================
// TS PROXY
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
            "*",

          "Cache-Control":
            "no-store"
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

    console.log(
      "CHANNELS SAVED:",
      normalizeChannels(body).length
    );

    return json({
      status:
        "ok",
      count:
        normalizeChannels(body).length
    });

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
          60
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
// DEBUG VERSION
// ============================================================

async function debugVersionApi() {
  return json({
    version:
      "CHANNEL_DEBUG_V4",

    worker:
      "super-tv-api",

    time:
      new Date().toISOString()
  });
}

// ============================================================
// DEBUG CHANNELS
// ============================================================

async function debugChannelsApi(
  request,
  env
) {
  const security =
    await securityGuard(
      request,
      env,
      "debug"
    );

  if (
    !security.allowed
  ) {
    return security.response;
  }

  const kvData =
    await loadChannelsFromKV(
      env
    );

  const assetData =
    await loadChannelsFromAssets(
      env
    );

  const kvChannels =
    normalizeChannels(
      kvData
    );

  const assetChannels =
    normalizeChannels(
      assetData
    );

  const targetId =
    "test_http";

  return json({
    version:
      "CHANNEL_DEBUG_V4",

    kvCount:
      kvChannels.length,

    assetCount:
      assetChannels.length,

    testHttpInKV:
      kvChannels.some(
        c =>
          String(c.id) ===
          targetId
      ),

    testHttpInAssets:
      assetChannels.some(
        c =>
          String(c.id) ===
          targetId
      ),

    kvIds:
      kvChannels
        .slice(0, 100)
        .map(
          c =>
            String(c.id)
        ),

    assetIds:
      assetChannels
        .slice(0, 100)
        .map(
          c =>
            String(c.id)
        )
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
    // DEBUG VERSION
    // ========================================================

    if (
      url.pathname ===
      "/api/debug-version"
    ) {
      return debugVersionApi();
    }

    // ========================================================
    // DEBUG CHANNELS
    // ========================================================

    if (
      url.pathname ===
      "/api/debug-channels"
    ) {
      return debugChannelsApi(
        request,
        env
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
    // HLS
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
