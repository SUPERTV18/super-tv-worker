// ============================================================
// SUPER TV API - Cloudflare Worker
// ============================================================

const NEW_UA = "stv2026";
const OLD_UA = "2026stv";

const FALLBACK_VIDEO =
  "https://github.com/himasabry/video/raw/refs/heads/main/output.m3u8";

const PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

// ============================================================
// RATE LIMIT SETTINGS
// ============================================================

// عدد طلبات تشغيل القنوات المسموح بها لكل IP + App Key
const PLAY_RATE_LIMIT = 30;

// المدة الزمنية
const PLAY_RATE_WINDOW = 60;

// عدد محاولات الدخول الخاطئة لكل IP
const INVALID_RATE_LIMIT = 15;

// مدة حظر المحاولات الخاطئة
const INVALID_RATE_WINDOW = 60;


// ============================================================
// HELPERS
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
// HASH
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
        b.toString(16)
         .padStart(2, "0")
    )
    .join("");
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
          limit - 1
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


    // لا نوقف التطبيق بالكامل
    // إذا حدث خطأ في KV
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


  // ----------------------------------------
  // User-Agent
  // ----------------------------------------

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


  // ----------------------------------------
  // APP_SECRET
  // ----------------------------------------

  if (!env.APP_SECRET) {

    console.error(
      "APP_SECRET is not configured"
    );

    return {
      allowed: false,
      reason: "server"
    };

  }


  // ----------------------------------------
  // APP KEY
  // ----------------------------------------

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

    // نعمل Rate Limit للمحاولات
    // الخاطئة حسب IP فقط
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

  // ----------------------------------------
  // KV
  // ----------------------------------------

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


  // ----------------------------------------
  // ASSETS
  // ----------------------------------------

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
// PLAY M3U8
// ============================================================

async function playApi(
  request,
  env,
  url
) {

  try {

    // ----------------------------------------
    // ID
    // ----------------------------------------

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


    // ----------------------------------------
    // OLD UA
    // ----------------------------------------

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


    // ----------------------------------------
    // SECURITY
    // ----------------------------------------

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


    // ----------------------------------------
    // VIEWER
    // ----------------------------------------

    await incrementViewer(
      env,
      id
    );


    // ----------------------------------------
    // CHANNELS
    // ----------------------------------------

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


    // ----------------------------------------
    // NOT FOUND
    // ----------------------------------------

    if (!channel) {

      return text(
        "Channel not found",
        404
      );

    }


    // ----------------------------------------
    // URL MISSING
    // ----------------------------------------

    if (!channel.url) {

      return text(
        "Channel URL missing",
        404
      );

    }


    // ----------------------------------------
    // NORMAL CHANNEL
    // ----------------------------------------

    if (
      !channel.url
        .toLowerCase()
        .includes(
          "ostora"
        )
    ) {

      return Response.redirect(
        channel.url,
        302
      );

    }


    // ----------------------------------------
    // OSTORA
    // ----------------------------------------

    const cleanUrl =
      channel.url.split(
        "#"
      )[0];


    const response =
      await fetch(
        cleanUrl,
        {
          headers: {

            "User-Agent":
              "Mozilla/5.0",

            "Referer":
              "https://ostora.pages.dev/"

          }
        }
      );


    if (!response.ok) {

      return text(
        `Upstream error: ${response.status}`,
        response.status
      );

    }


    return Response.redirect(
      response.url,
      302
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
      await fetch(
        target,
        {
          redirect:
            "follow",

          headers: {

            "User-Agent":
              PROXY_UA

          }
        }
      );


    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "";


    if (
      contentType.includes(
        "mpegurl"
      ) ||
      target.includes(
        ".m3u8"
      )
    ) {

      let body =
        await upstream.text();


      const base =
        url.origin;


      body =
        body.replace(
          /(https?:\/\/[^\s]+)/g,

          u =>
            `${base}/api/ts?url=${encodeURIComponent(u)}`
        );


      return new Response(
        body,
        {
          status: 200,

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
            "*"

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
      await fetch(
        target,
        {
          headers: {

            "User-Agent":
              PROXY_UA

          }
        }
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
      [id]:
        0
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


  } catch (e) {

    return json({

      [id]:
        0

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
