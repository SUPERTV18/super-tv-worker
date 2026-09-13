// ======================================================
// SUPER TV API - Cloudflare Worker
// حماية User-Agent + Secret مخفي
// + اختبار مؤقت داخل play.m3u8
// ======================================================

const NEW_UA = "stv2026";
const OLD_UA = "2026stv";

const FALLBACK_VIDEO =
  "https://github.com/himasabry/video/raw/refs/heads/main/output.m3u8";

const PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";


// ======================================================
// أدوات عامة
// ======================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}


function text(
  data,
  status = 200,
  contentType = "text/plain; charset=utf-8"
) {
  return new Response(data, {
    status,
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*"
    }
  });
}


function redirect(url, status = 302) {
  return Response.redirect(url, status);
}


// ======================================================
// CORS
// ======================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };
}


// ======================================================
// حماية التطبيق
//
// يجب أن يرسل التطبيق:
//
// User-Agent: stv2026
// X-App-Key: القيمة الموجودة في Cloudflare Secret
// ======================================================

function checkAppSecurity(request, env) {

  const ua =
    (
      request.headers.get("User-Agent") || ""
    ).toLowerCase();

  const appKey =
    request.headers.get("X-App-Key") || "";


  // ----------------------------------------------------
  // User-Agent
  // ----------------------------------------------------

  if (
    !ua.includes(
      NEW_UA.toLowerCase()
    )
  ) {
    return false;
  }


  // ----------------------------------------------------
  // Secret
  // ----------------------------------------------------

  if (!env.APP_SECRET) {

    console.error(
      "APP_SECRET is not configured"
    );

    return false;
  }


  if (
    appKey !== env.APP_SECRET
  ) {
    return false;
  }


  return true;
}


// ======================================================
// قراءة channels.json
//
// الأولوية:
// 1- KV
// 2- data/channels.json من Assets
// ======================================================

async function loadChannels(
  env,
  request
) {

  if (env.DATA_KV) {

    try {

      const saved =
        await env.DATA_KV.get(
          "channels"
        );


      if (saved) {

        return JSON.parse(
          saved
        );
      }

    } catch (e) {

      console.error(
        "KV CHANNELS ERROR:",
        e
      );
    }
  }


  try {

    const url =
      new URL(request.url);


    url.pathname =
      "/data/channels.json";


    url.search = "";


    const response =
      await env.ASSETS.fetch(
        new Request(
          url.toString(),
          {
            method: "GET"
          }
        )
      );


    if (!response.ok) {

      throw new Error(
        `channels.json HTTP ${response.status}`
      );
    }


    return await response.json();

  } catch (e) {

    console.error(
      "ASSET CHANNELS ERROR:",
      e
    );


    throw new Error(
      "channels.json not found"
    );
  }
}


// ======================================================
// البحث عن قناة
// ======================================================

function findChannel(
  data,
  id
) {

  for (
    const group of Object.values(data)
  ) {

    if (
      !Array.isArray(group)
    ) {
      continue;
    }


    const found =
      group.find(
        ch =>
          String(ch.id) ===
          String(id)
      );


    if (found) {
      return found;
    }
  }


  return null;
}


// ======================================================
// عداد المشاهدين
// ======================================================

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


    const now =
      Date.now();


    let count = 0;


    if (
      old &&
      typeof old === "object"
    ) {

      if (
        old.lastActivity &&
        now -
          old.lastActivity <=
          30000
      ) {

        count =
          Number(
            old.count || 0
          ) + 1;

      } else {

        count = 1;
      }

    } else {

      count = 1;
    }


    await env.DATA_KV.put(
      key,
      JSON.stringify({
        count,
        lastActivity: now
      }),
      {
        expirationTtl: 31
      }
    );


  } catch (e) {

    console.error(
      "VIEWER INCREMENT ERROR:",
      e
    );
  }
}


// ======================================================
// API: /api/viewers
// ======================================================

async function viewersApi(
  request,
  env
) {

  const url =
    new URL(request.url);


  const id =
    url.searchParams.get(
      "id"
    );


  if (!id) {

    return json(
      {
        error: "Missing id"
      },
      400
    );
  }


  let count = 0;


  if (env.DATA_KV) {

    try {

      const data =
        await env.DATA_KV.get(
          `viewer:${id}`,
          "json"
        );


      if (
        data &&
        typeof data === "object"
      ) {

        count =
          Number(
            data.count || 0
          );
      }

    } catch (e) {

      console.error(
        "VIEWERS API ERROR:",
        e
      );
    }
  }


  return json({
    [id]: count
  });
}


// ======================================================
// API: /api/channels
// ======================================================

async function channelsApi(
  request,
  env
) {

  try {

    const data =
      await loadChannels(
        env,
        request
      );


    return json(
      data
    );

  } catch (e) {

    return json(
      {
        error: e.message
      },
      500
    );
  }
}


// ======================================================
// API: /api/save
// ======================================================

async function saveApi(
  request,
  env
) {

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


  // ----------------------------------------------------
  // حماية Secret
  // ----------------------------------------------------

  if (
    !checkAppSecurity(
      request,
      env
    )
  ) {

    return text(
      "Forbidden",
      403
    );
  }


  if (!env.DATA_KV) {

    return json(
      {
        error:
          "DATA_KV is not configured"
      },
      500
    );
  }


  try {

    const body =
      await request.json();


    await env.DATA_KV.put(
      "channels",
      JSON.stringify(body)
    );


    return json({
      status: "ok"
    });


  } catch (e) {

    console.error(
      "SAVE ERROR:",
      e
    );


    return json(
      {
        error: e.message
      },
      500
    );
  }
}


// ======================================================
// API: /api/playlist.m3u
// ======================================================

async function playlistApi(
  request,
  env
) {

  try {

    const data =
      await loadChannels(
        env,
        request
      );


    const requestUrl =
      new URL(request.url);


    const base =
      requestUrl.origin;


    let m3u =
      "#EXTM3U\n";


    for (
      const category in data
    ) {

      if (
        !Array.isArray(
          data[category]
        )
      ) {
        continue;
      }


      for (
        const ch of data[category]
      ) {

        m3u +=
          `#EXTINF:-1 tvg-id="${ch.id}" group-title="${category}",${ch.name}\n`;


        m3u +=
          `${base}/api/play.m3u8?id=${encodeURIComponent(ch.id)}\n`;
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
            "*"
        }
      }
    );


  } catch (e) {

    console.error(
      "PLAYLIST ERROR:",
      e
    );


    return text(
      "Playlist error",
      500
    );
  }
}


// ======================================================
// API: /api/play.m3u8
// ======================================================

async function playApi(
  request,
  env
) {

  try {

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


    // ==================================================
    // DEBUG
    //
    // استخدم:
    //
    // /api/play.m3u8?id=debug
    //
    // لا يعرض قيمة المفتاح نفسها.
    // ==================================================

    if (
      id === "debug"
    ) {

      const ua =
        request.headers.get(
          "User-Agent"
        ) || "";


      const appKey =
        request.headers.get(
          "X-App-Key"
        ) || "";


      return json({

        uaReceived:
          !!ua,

        uaHasStv2026:
          ua
            .toLowerCase()
            .includes(
              NEW_UA.toLowerCase()
            ),

        appKeyReceived:
          !!appKey,

        appKeyValid:
          !!env.APP_SECRET &&
          appKey ===
            env.APP_SECRET

      });
    }


    // ==================================================
    // User-Agent
    // ==================================================

    const ua =
      (
        request.headers.get(
          "User-Agent"
        ) || ""
      ).toLowerCase();


    // ==================================================
    // UA القديم
    // ==================================================

    if (
      ua.includes(
        OLD_UA.toLowerCase()
      ) ||
      ua.includes(
        "superlivetv"
      )
    ) {

      return redirect(
        FALLBACK_VIDEO,
        302
      );
    }


    // ==================================================
    // الحماية الجديدة
    //
    // User-Agent + X-App-Key
    // ==================================================

    if (
      !checkAppSecurity(
        request,
        env
      )
    ) {

      return text(
        "Forbidden",
        403
      );
    }


    // ==================================================
    // عداد المشاهدين
    // ==================================================

    await incrementViewer(
      env,
      id
    );


    // ==================================================
    // قراءة القنوات
    // ==================================================

    let data;


    try {

      data =
        await loadChannels(
          env,
          request
        );

    } catch (e) {

      return text(
        "channels.json not found",
        500
      );
    }


    // ==================================================
    // البحث عن القناة
    // ==================================================

    const channel =
      findChannel(
        data,
        id
      );


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


    // ==================================================
    // القنوات العادية
    // ==================================================

    if (
      !channel.url
        .toLowerCase()
        .includes(
          "ostora"
        )
    ) {

      return redirect(
        channel.url,
        302
      );
    }


    // ==================================================
    // OSTORA
    // ==================================================

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
          },

          redirect:
            "follow"
        }
      );


    if (!response.ok) {

      return text(
        `Upstream error: ${response.status}`,
        response.status
      );
    }


    return redirect(
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


// ======================================================
// API: /api/proxy.m3u8
// ======================================================

async function proxyM3u8Api(
  request,
  env
) {

  // ----------------------------------------------------
  // حماية الـ Proxy
  // ----------------------------------------------------

  if (
    !checkAppSecurity(
      request,
      env
    )
  ) {

    return text(
      "Forbidden",
      403
    );
  }


  const url =
    new URL(request.url);


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


    // ==================================================
    // M3U8
    // ==================================================

    if (
      contentType
        .toLowerCase()
        .includes(
          "mpegurl"
        ) ||
      target
        .toLowerCase()
        .includes(
          ".m3u8"
        )
    ) {

      let body =
        await upstream.text();


      body =
        body.replace(
          /(https?:\/\/[^\s]+)/g,
          (u) =>
            `${url.origin}/api/ts?url=${encodeURIComponent(u)}`
        );


      return new Response(
        body,
        {
          status:
            upstream.status,

          headers: {

            "Content-Type":
              "application/vnd.apple.mpegurl",

            "Access-Control-Allow-Origin":
              "*"
          }
        }
      );
    }


    // ==================================================
    // أي محتوى آخر
    // ==================================================

    const headers =
      new Headers();


    headers.set(
      "Access-Control-Allow-Origin",
      "*"
    );


    if (contentType) {

      headers.set(
        "Content-Type",
        contentType
      );
    }


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
      "PROXY ERROR:",
      e
    );


    return text(
      "Proxy error",
      500
    );
  }
}


// ======================================================
// API: /api/ts
// ======================================================

async function tsApi(
  request,
  env
) {

  // ----------------------------------------------------
  // حماية الـ TS Proxy
  // ----------------------------------------------------

  if (
    !checkAppSecurity(
      request,
      env
    )
  ) {

    return text(
      "Forbidden",
      403
    );
  }


  const url =
    new URL(request.url);


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


    const contentType =
      upstream.headers.get(
        "content-type"
      ) ||
      "video/mp2t";


    return new Response(
      upstream.body,
      {
        status:
          upstream.status,

        headers: {

          "Content-Type":
            contentType,

          "Access-Control-Allow-Origin":
            "*"
        }
      }
    );


  } catch (e) {

    console.error(
      "TS PROXY ERROR:",
      e
    );


    return text(
      "TS Proxy Error",
      500
    );
  }
}


// ======================================================
// OPTIONS
// ======================================================

function handleOptions() {

  return new Response(
    null,
    {
      status: 204,
      headers:
        corsHeaders()
    }
  );
}


// ======================================================
// Worker Router
// ======================================================

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(request.url);


    const pathname =
      url.pathname;


    // ------------------------------------------
    // CORS preflight
    // ------------------------------------------

    if (
      request.method ===
      "OPTIONS"
    ) {

      return handleOptions();
    }


    // ------------------------------------------
    // /api/channels
    // ------------------------------------------

    if (
      pathname ===
      "/api/channels"
    ) {

      return channelsApi(
        request,
        env
      );
    }


    // ------------------------------------------
    // /api/play.m3u8
    // ------------------------------------------

    if (
      pathname ===
      "/api/play.m3u8"
    ) {

      return playApi(
        request,
        env
      );
    }


    // ------------------------------------------
    // /api/playlist.m3u
    // ------------------------------------------

    if (
      pathname ===
      "/api/playlist.m3u"
    ) {

      return playlistApi(
        request,
        env
      );
    }


    // ------------------------------------------
    // /api/proxy.m3u8
    // ------------------------------------------

    if (
      pathname ===
      "/api/proxy.m3u8"
    ) {

      return proxyM3u8Api(
        request,
        env
      );
    }


    // ------------------------------------------
    // /api/ts
    // ------------------------------------------

    if (
      pathname ===
      "/api/ts"
    ) {

      return tsApi(
        request,
        env
      );
    }


    // ------------------------------------------
    // /api/save
    // ------------------------------------------

    if (
      pathname ===
      "/api/save"
    ) {

      return saveApi(
        request,
        env
      );
    }


    // ------------------------------------------
    // /api/viewers
    // ------------------------------------------

    if (
      pathname ===
      "/api/viewers"
    ) {

      return viewersApi(
        request,
        env
      );
    }


    // ------------------------------------------
    // /admin
    // ------------------------------------------

    if (
      pathname ===
        "/admin" ||
      pathname ===
        "/admin/"
    ) {

      const adminUrl =
        new URL(request.url);


      adminUrl.pathname =
        "/admin.html";


      return env.ASSETS.fetch(
        new Request(
          adminUrl,
          request
        )
      );
    }


    // ------------------------------------------
    // الملفات الثابتة
    // ------------------------------------------

    return env.ASSETS.fetch(
      request
    );
  }
};
