// ============================================================
// SUPER TV API - Cloudflare Worker
// تحويل api/play.m3u8.js من Vercel إلى Cloudflare Worker
// نفس طريقة العمل الأصلية
// ============================================================

const NEW_UA = "stv2026";
const OLD_UA = "2026stv";

// ============================================================
// فيديو الاستجابة للـ UA القديم
// ============================================================

const FALLBACK_VIDEO =
  "https://github.com/himasabry/video/raw/refs/heads/main/output.m3u8";

// ============================================================
// CORS
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Admin-Key, User-Agent, Referer, Origin",
};

// ============================================================
// Response Helpers
// ============================================================

function txt(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function redirect(url) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      ...corsHeaders,
    },
  });
}

// ============================================================
// Load channels.json
// ============================================================

async function loadChannels(env, req) {
  // ----------------------------------------------------------
  // أولاً نحاول KV
  // ----------------------------------------------------------

  if (env.DATA_KV) {
    try {
      const data = await env.DATA_KV.get(
        "channels",
        "json"
      );

      if (data) {
        return data;
      }
    } catch (e) {
      console.error(
        "KV channels error:",
        e
      );
    }
  }

  // ----------------------------------------------------------
  // fallback إلى:
  // public/data/channels.json
  // ----------------------------------------------------------

  if (!env.ASSETS) {
    throw new Error(
      "ASSETS binding is missing"
    );
  }

  const url = new URL(
    "/data/channels.json",
    req.url
  );

  const response = await env.ASSETS.fetch(
    new Request(url)
  );

  if (!response.ok) {
    throw new Error(
      "channels.json not found"
    );
  }

  return await response.json();
}

// ============================================================
// Find Channel
// ============================================================

function findChannel(data, id) {
  for (const group of Object.values(data)) {
    if (!Array.isArray(group)) {
      continue;
    }

    const found = group.find(
      (channel) =>
        String(channel.id) === String(id)
    );

    if (found) {
      return found;
    }
  }

  return null;
}

// ============================================================
// Viewer Counter
// ============================================================

async function incrementViewer(env, id) {
  if (!env.DATA_KV) {
    return;
  }

  try {
    const key = `viewer:${id}`;

    const current = Number(
      (await env.DATA_KV.get(key)) || 0
    );

    await env.DATA_KV.put(
      key,
      String(current + 1),
      {
        expirationTtl: 35,
      }
    );
  } catch (e) {
    console.error(
      "VIEWER ERROR:",
      e
    );
  }
}

// ============================================================
// PLAY API
// ============================================================

async function play(req, env) {
  try {
    const url = new URL(req.url);

    const id =
      url.searchParams.get("id");

    // --------------------------------------------------------
    // Missing ID
    // --------------------------------------------------------

    if (!id) {
      return txt(
        "Missing id",
        400
      );
    }

    // --------------------------------------------------------
    // User-Agent
    // نفس حماية Vercel بالضبط
    // --------------------------------------------------------

    const userAgent =
      req.headers.get("User-Agent") || "";

    const ua =
      userAgent.toLowerCase();

    // --------------------------------------------------------
    // Viewer Counter
    // --------------------------------------------------------

    await incrementViewer(
      env,
      id
    );

    // --------------------------------------------------------
    // UA القديم
    // --------------------------------------------------------

    if (
      ua.includes(
        OLD_UA.toLowerCase()
      ) ||
      ua.includes("superlivetv")
    ) {
      return redirect(
        FALLBACK_VIDEO
      );
    }

    // --------------------------------------------------------
    // السماح للتطبيق فقط
    // --------------------------------------------------------

    if (
      !ua.includes(
        NEW_UA.toLowerCase()
      )
    ) {
      return txt(
        "Forbidden",
        403
      );
    }

    // --------------------------------------------------------
    // قراءة channels.json
    // --------------------------------------------------------

    const data =
      await loadChannels(
        env,
        req
      );

    // --------------------------------------------------------
    // البحث عن القناة
    // --------------------------------------------------------

    const channel =
      findChannel(
        data,
        id
      );

    // --------------------------------------------------------
    // القناة غير موجودة
    // --------------------------------------------------------

    if (!channel) {
      return txt(
        "Channel not found",
        404
      );
    }

    // --------------------------------------------------------
    // الرابط غير موجود
    // --------------------------------------------------------

    if (!channel.url) {
      return txt(
        "Channel URL missing",
        404
      );
    }

    // ========================================================
    // القنوات العادية
    //
    // نفس Vercel بالضبط:
    //
    // return res
    //   .status(302)
    //   .setHeader("Location", channel.url)
    //   .end();
    // ========================================================

    if (
      !String(channel.url)
        .toLowerCase()
        .includes("ostora")
    ) {
      return redirect(
        String(channel.url)
      );
    }

    // ========================================================
    // OSTORA
    // ========================================================

    const cleanUrl =
      String(channel.url)
        .split("#")[0];

    let response;

    try {
      response = await fetch(
        cleanUrl,
        {
          method: "GET",
          redirect: "follow",
          headers: {
            "User-Agent":
              "Mozilla/5.0",
            "Referer":
              "https://ostora.pages.dev/",
          },
        }
      );
    } catch (e) {
      console.error(
        "UPSTREAM FETCH ERROR:",
        e
      );

      return txt(
        "Upstream fetch error: " +
          (e?.message ||
            "Unknown error"),
        502
      );
    }

    // --------------------------------------------------------
    // Upstream Error
    // --------------------------------------------------------

    if (!response.ok) {
      return txt(
        `Upstream error: ${response.status}`,
        response.status
      );
    }

    // --------------------------------------------------------
    // نفس Vercel:
    // Redirect إلى الرابط النهائي
    // --------------------------------------------------------

    return redirect(
      response.url
    );

  } catch (e) {
    console.error(
      "PLAY ERROR:",
      e
    );

    return txt(
      "Server error: " +
        (e?.message ||
          "Unknown error"),
      500
    );
  }
}

// ============================================================
// CHANNELS API
// ============================================================

async function channelsApi(
  req,
  env
) {
  try {
    // --------------------------------------------------------
    // GET
    // --------------------------------------------------------

    if (
      req.method === "GET"
    ) {
      return json(
        await loadChannels(
          env,
          req
        )
      );
    }

    // --------------------------------------------------------
    // POST
    // --------------------------------------------------------

    if (
      req.method !== "POST"
    ) {
      return json(
        {
          error:
            "Method not allowed",
        },
        405
      );
    }

    // --------------------------------------------------------
    // Admin key
    // --------------------------------------------------------

    if (env.ADMIN_KEY) {
      const key =
        req.headers.get(
          "X-Admin-Key"
        );

      if (
        key !== env.ADMIN_KEY
      ) {
        return json(
          {
            error:
              "Unauthorized",
          },
          401
        );
      }
    }

    // --------------------------------------------------------
    // KV required
    // --------------------------------------------------------

    if (!env.DATA_KV) {
      return json(
        {
          error:
            "DATA_KV binding is required",
        },
        500
      );
    }

    const body =
      await req.json();

    await env.DATA_KV.put(
      "channels",
      JSON.stringify(body)
    );

    return json({
      status: "ok",
    });

  } catch (e) {
    console.error(
      "CHANNEL API ERROR:",
      e
    );

    return json(
      {
        error:
          e?.message ||
          "Unknown error",
      },
      500
    );
  }
}

// ============================================================
// VIEWERS API
// ============================================================

async function viewers(
  req,
  env
) {
  try {
    const id =
      new URL(req.url)
        .searchParams
        .get("id");

    if (!id) {
      return json(
        {
          error:
            "Missing id",
        },
        400
      );
    }

    let count = 0;

    if (env.DATA_KV) {
      count = Number(
        (await env.DATA_KV.get(
          `viewer:${id}`
        )) || 0
      );
    }

    return json({
      [id]: count,
    });

  } catch (e) {
    return json(
      {
        error:
          e?.message ||
          "Unknown error",
      },
      500
    );
  }
}

// ============================================================
// PLAYLIST
// ============================================================

async function playlist(
  req,
  env
) {
  try {
    const data =
      await loadChannels(
        env,
        req
      );

    const base =
      new URL(req.url)
        .origin;

    let m3u =
      "#EXTM3U\n";

    for (
      const group in data
    ) {
      const list =
        Array.isArray(
          data[group]
        )
          ? data[group]
          : [];

      for (
        const channel of list
      ) {
        m3u +=
          `#EXTINF:-1 tvg-id="${channel.id}" ` +
          `group-title="${group}",${channel.name}\n`;

        m3u +=
          `${base}/api/play.m3u8?id=` +
          encodeURIComponent(
            channel.id
          ) +
          "\n";
      }
    }

    return new Response(
      m3u,
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/x-mpegURL; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="SuperTV.m3u"',
          ...corsHeaders,
          "Cache-Control":
            "no-store",
        },
      }
    );

  } catch (e) {
    return txt(
      "Playlist error: " +
        (e?.message ||
          "Unknown error"),
      500
    );
  }
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(
    req,
    env
  ) {
    try {
      const url =
        new URL(req.url);

      const path =
        url.pathname;

      // ------------------------------------------------------
      // CORS OPTIONS
      // ------------------------------------------------------

      if (
        req.method ===
        "OPTIONS"
      ) {
        return new Response(
          null,
          {
            status: 204,
            headers:
              corsHeaders,
          }
        );
      }

      // ------------------------------------------------------
      // PLAY
      // ------------------------------------------------------

      if (
        path ===
        "/api/play.m3u8"
      ) {
        return await play(
          req,
          env
        );
      }

      // ------------------------------------------------------
      // CHANNELS
      // ------------------------------------------------------

      if (
        path ===
          "/api/channels" ||
        path ===
          "/api/save"
      ) {
        return await channelsApi(
          req,
          env
        );
      }

      // ------------------------------------------------------
      // VIEWERS
      // ------------------------------------------------------

      if (
        path ===
        "/api/viewers"
      ) {
        return await viewers(
          req,
          env
        );
      }

      // ------------------------------------------------------
      // PLAYLIST
      // ------------------------------------------------------

      if (
        path ===
        "/api/playlist.m3u"
      ) {
        return await playlist(
          req,
          env
        );
      }

      // ------------------------------------------------------
      // ADMIN
      // ------------------------------------------------------

      if (
        path === "/admin" ||
        path === "/admin/"
      ) {
        return env.ASSETS.fetch(
          new Request(
            new URL(
              "/admin.html",
              req.url
            ),
            req
          )
        );
      }

      // ------------------------------------------------------
      // STATIC ASSETS
      // ------------------------------------------------------

      return env.ASSETS.fetch(
        req
      );

    } catch (e) {
      console.error(
        "WORKER ERROR:",
        e
      );

      return txt(
        "Server error: " +
          (e?.message ||
            "Unknown error"),
        500
      );
    }
  },
};
