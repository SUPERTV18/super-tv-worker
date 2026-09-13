```javascript
// ============================================================
// SUPER TV API - Cloudflare Worker
// ============================================================

const NEW_UA = "stv2026";
const OLD_UA = "2026stv";

const FALLBACK =
  "https://github.com/himasabry/video/raw/refs/heads/main/output.m3u8";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

// ============================================================
// Response Helpers
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Admin-Key, User-Agent, Referer, Origin",
};

const txt = (s, n = 200, h = {}) =>
  new Response(s, {
    status: n,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders,
      ...h,
    },
  });

const js = (o, n = 200) =>
  new Response(JSON.stringify(o), {
    status: n,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });

const red = (u) =>
  new Response(null, {
    status: 302,
    headers: {
      Location: u,
      ...corsHeaders,
    },
  });

// ============================================================
// Load Channels
// ============================================================

async function channels(env, req) {
  // أولاً نحاول KV
  if (env.DATA_KV) {
    const x = await env.DATA_KV.get("channels", "json");

    if (x) {
      return x;
    }
  }

  // fallback إلى public/data/channels.json
  if (!env.ASSETS) {
    throw new Error("ASSETS binding is missing");
  }

  const r = await env.ASSETS.fetch(
    new Request(new URL("/data/channels.json", req.url))
  );

  if (!r.ok) {
    throw new Error("channels.json not found");
  }

  return await r.json();
}

// ============================================================
// Admin Authorization
// ============================================================

async function saveAllowed(req, env) {
  if (!env.ADMIN_KEY) {
    return true;
  }

  return req.headers.get("X-Admin-Key") === env.ADMIN_KEY;
}

// ============================================================
// Viewer Counter
// ============================================================

async function inc(env, id) {
  if (!env.DATA_KV) return;

  const key = `viewer:${id}`;

  const current = Number(
    (await env.DATA_KV.get(key)) || 0
  );

  await env.DATA_KV.put(key, String(current + 1), {
    expirationTtl: 35,
  });
}

// ============================================================
// Find Channel
// ============================================================

function findChannel(data, id) {
  for (const group of Object.values(data)) {
    if (!Array.isArray(group)) continue;

    const channel = group.find(
      (x) => String(x.id) === String(id)
    );

    if (channel) {
      return channel;
    }
  }

  return null;
}

// ============================================================
// Build Headers For Upstream
// ============================================================

function buildUpstreamHeaders(channel) {
  const h = channel?.headers || {};

  const headers = {
    "User-Agent":
      h["User-Agent"] ||
      h["user-agent"] ||
      NEW_UA,
  };

  const referer =
    h["Referer"] ||
    h["referer"];

  const origin =
    h["Origin"] ||
    h["origin"];

  if (referer) {
    headers["Referer"] = referer;
  }

  if (origin) {
    headers["Origin"] = origin;
  }

  return headers;
}

// ============================================================
// Resolve Relative URL
// ============================================================

function absoluteUrl(base, value) {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

// ============================================================
// Create Proxy URL
// ============================================================

function makeProxyUrl(req, url, id) {
  const x = new URL("/api/proxy.m3u8", req.url);

  x.searchParams.set("url", url);

  if (id) {
    x.searchParams.set("id", id);
  }

  return x.toString();
}

// ============================================================
// Rewrite M3U8
// ============================================================

function rewriteM3U8(req, text, baseUrl, id) {
  const lines = text.split(/\r?\n/);

  const output = [];

  for (let line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      output.push(line);
      continue;
    }

    // --------------------------------------------------------
    // URI داخل EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA وغيرها
    // --------------------------------------------------------

    if (trimmed.startsWith("#")) {
      line = line.replace(
        /URI="([^"]+)"/gi,
        (match, uri) => {
          const absolute = absoluteUrl(baseUrl, uri);

          return `URI="${makeProxyUrl(req, absolute, id)}"`;
        }
      );

      output.push(line);
      continue;
    }

    // --------------------------------------------------------
    // Segment / Child Playlist
    // --------------------------------------------------------

    const absolute = absoluteUrl(baseUrl, trimmed);

    output.push(
      makeProxyUrl(req, absolute, id)
    );
  }

  return output.join("\n");
}

// ============================================================
// PLAY API
// ============================================================

async function play(req, env) {
  const u = new URL(req.url);

  const id = u.searchParams.get("id");

  if (!id) {
    return txt("Missing id", 400);
  }

  // ----------------------------------------------------------
  // Check Player User-Agent
  // ----------------------------------------------------------

  const playerUA =
    req.headers.get("User-Agent") || "";

  const ua = playerUA.toLowerCase();

  // old client
  if (
    ua.includes(OLD_UA.toLowerCase()) ||
    ua.includes("superlivetv")
  ) {
    return red(FALLBACK);
  }

  // new client
  if (!ua.includes(NEW_UA.toLowerCase())) {
    return txt("Forbidden", 403);
  }

  // ----------------------------------------------------------
  // Viewer count
  // ----------------------------------------------------------

  await inc(env, id);

  // ----------------------------------------------------------
  // Load channels
  // ----------------------------------------------------------

  const data = await channels(env, req);

  const ch = findChannel(data, id);

  if (!ch) {
    return txt("Channel not found", 404);
  }

  if (!ch.url) {
    return txt("Channel URL missing", 404);
  }

  // ----------------------------------------------------------
  // Upstream URL
  // ----------------------------------------------------------

  const sourceUrl = String(ch.url).split("#")[0];

  // ----------------------------------------------------------
  // Get source headers from channels.json
  // ----------------------------------------------------------

  const upstreamHeaders =
    buildUpstreamHeaders(ch);

  // ----------------------------------------------------------
  // Fetch source
  // ----------------------------------------------------------

  let r;

  try {
    r = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      headers: upstreamHeaders,
    });
  } catch (e) {
    console.error("UPSTREAM FETCH ERROR:", e);

    return txt(
      "Upstream fetch error: " +
        (e?.message || "Unknown error"),
      502
    );
  }

  if (!r.ok) {
    return txt(
      `Upstream error: ${r.status}`,
      r.status
    );
  }

  // ----------------------------------------------------------
  // Detect Content Type
  // ----------------------------------------------------------

  const contentType =
    r.headers.get("content-type") || "";

  const finalUrl = r.url || sourceUrl;

  const looksM3U8 =
    contentType.toLowerCase().includes("mpegurl") ||
    contentType.toLowerCase().includes("m3u8") ||
    sourceUrl.toLowerCase().includes(".m3u8") ||
    finalUrl.toLowerCase().includes(".m3u8");

  // ----------------------------------------------------------
  // If M3U8
  // ----------------------------------------------------------

  if (looksM3U8) {
    const body = await r.text();

    const rewritten = rewriteM3U8(
      req,
      body,
      finalUrl,
      id
    );

    return new Response(rewritten, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.apple.mpegurl",
        ...corsHeaders,
        "Cache-Control":
          "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
    });
  }

  // ----------------------------------------------------------
  // Non-M3U8 response
  // ----------------------------------------------------------

  return new Response(r.body, {
    status: r.status,
    headers: {
      "Content-Type":
        contentType ||
        "application/octet-stream",
      ...corsHeaders,
      "Cache-Control": "no-store",
    },
  });
}

// ============================================================
// CHANNELS API
// ============================================================

async function channelsApi(req, env) {
  if (req.method === "GET") {
    return js(await channels(env, req));
  }

  if (req.method !== "POST") {
    return js(
      { error: "Method not allowed" },
      405
    );
  }

  if (!(await saveAllowed(req, env))) {
    return js(
      { error: "Unauthorized" },
      401
    );
  }

  if (!env.DATA_KV) {
    return js(
      {
        error:
          "DATA_KV binding is required for saving channels",
      },
      500
    );
  }

  const body = await req.json();

  await env.DATA_KV.put(
    "channels",
    JSON.stringify(body)
  );

  return js({
    status: "ok",
  });
}

// ============================================================
// VIEWERS API
// ============================================================

async function viewers(req, env) {
  const id =
    new URL(req.url).searchParams.get("id");

  if (!id) {
    return js(
      { error: "Missing id" },
      400
    );
  }

  const n = env.DATA_KV
    ? Number(
        (await env.DATA_KV.get(`viewer:${id}`)) ||
          0
      )
    : 0;

  return js({
    [id]: n,
  });
}

// ============================================================
// PROXY M3U8
// ============================================================

async function proxy(req, env) {
  const url = new URL(req.url);

  const target =
    url.searchParams.get("url");

  const id =
    url.searchParams.get("id");

  if (!target) {
    return txt("Missing url", 400);
  }

  try {
    // --------------------------------------------------------
    // Find channel headers if ID exists
    // --------------------------------------------------------

    let headers = {
      "User-Agent": BROWSER_UA,
    };

    if (id) {
      try {
        const data = await channels(env, req);

        const ch = findChannel(data, id);

        if (ch) {
          headers = buildUpstreamHeaders(ch);
        }
      } catch (e) {
        console.error(
          "CHANNEL HEADER ERROR:",
          e
        );
      }
    }

    // --------------------------------------------------------
    // Fetch
    // --------------------------------------------------------

    const r = await fetch(target, {
      redirect: "follow",
      headers,
    });

    const ct =
      r.headers.get("content-type") || "";

    const isM3U8 =
      ct.toLowerCase().includes("mpegurl") ||
      ct.toLowerCase().includes("m3u8") ||
      target.toLowerCase().includes(".m3u8");

    // --------------------------------------------------------
    // M3U8
    // --------------------------------------------------------

    if (isM3U8) {
      const body = await r.text();

      const rewritten = rewriteM3U8(
        req,
        body,
        r.url || target,
        id
      );

      return new Response(rewritten, {
        status: r.status,
        headers: {
          "Content-Type":
            "application/vnd.apple.mpegurl",
          ...corsHeaders,
          "Cache-Control":
            "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      });
    }

    // --------------------------------------------------------
    // Binary / Segment
    // --------------------------------------------------------

    return new Response(r.body, {
      status: r.status,
      headers: {
        "Content-Type":
          ct || "application/octet-stream",
        ...corsHeaders,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error(
      "Proxy error:",
      e
    );

    return txt(
      "Proxy error: " +
        (e?.message || "Unknown error"),
      500
    );
  }
}

// ============================================================
// TS / VIDEO SEGMENT PROXY
// ============================================================

async function ts(req, env) {
  const url = new URL(req.url);

  const target =
    url.searchParams.get("url");

  const id =
    url.searchParams.get("id");

  if (!target) {
    return txt("Missing url", 400);
  }

  try {
    let headers = {
      "User-Agent": BROWSER_UA,
    };

    // --------------------------------------------------------
    // Use channel headers when ID exists
    // --------------------------------------------------------

    if (id) {
      try {
        const data = await channels(env, req);

        const ch = findChannel(data, id);

        if (ch) {
          headers = buildUpstreamHeaders(ch);
        }
      } catch (e) {
        console.error(
          "TS CHANNEL HEADER ERROR:",
          e
        );
      }
    }

    const r = await fetch(target, {
      redirect: "follow",
      headers,
    });

    return new Response(r.body, {
      status: r.status,
      headers: {
        "Content-Type":
          r.headers.get("content-type") ||
          "video/mp2t",
        ...corsHeaders,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error(
      "TS Proxy Error:",
      e
    );

    return txt(
      "TS Proxy Error: " +
        (e?.message || "Unknown error"),
      500
    );
  }
}

// ============================================================
// PLAYLIST
// ============================================================

async function playlist(req, env) {
  const data = await channels(env, req);

  const base =
    new URL(req.url).origin;

  let m = "#EXTM3U\n";

  for (const group in data) {
    const list = Array.isArray(data[group])
      ? data[group]
      : [];

    for (const c of list) {
      m +=
        `#EXTINF:-1 tvg-id="${c.id}" ` +
        `group-title="${group}",${c.name}\n` +
        `${base}/api/play.m3u8?id=` +
        `${encodeURIComponent(c.id)}\n`;
    }
  }

  return new Response(m, {
    headers: {
      "Content-Type":
        "application/x-mpegURL; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="SuperTV.m3u"',
      ...corsHeaders,
      "Cache-Control": "no-store",
    },
  });
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(req, env) {
    try {
      const p =
        new URL(req.url).pathname;

      // ------------------------------------------------------
      // OPTIONS / CORS
      // ------------------------------------------------------

      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders,
        });
      }

      // ------------------------------------------------------
      // PLAY
      // ------------------------------------------------------

      if (p === "/api/play.m3u8") {
        return await play(req, env);
      }

      // ------------------------------------------------------
      // CHANNELS
      // ------------------------------------------------------

      if (
        p === "/api/channels" ||
        p === "/api/save"
      ) {
        return await channelsApi(
          req,
          env
        );
      }

      // ------------------------------------------------------
      // VIEWERS
      // ------------------------------------------------------

      if (p === "/api/viewers") {
        return await viewers(req, env);
      }

      // ------------------------------------------------------
      // PLAYLIST
      // ------------------------------------------------------

      if (p === "/api/playlist.m3u") {
        return await playlist(
          req,
          env
        );
      }

      // ------------------------------------------------------
      // M3U8 PROXY
      // ------------------------------------------------------

      if (p === "/api/proxy.m3u8") {
        return await proxy(
          req,
          env
        );
      }

      // ------------------------------------------------------
      // TS / VIDEO PROXY
      // ------------------------------------------------------

      if (p === "/api/ts") {
        return await ts(
          req,
          env
        );
      }

      // ------------------------------------------------------
      // ADMIN
      // ------------------------------------------------------

      if (
        p === "/admin" ||
        p === "/admin/"
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

      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(
        "WORKER ERROR:",
        e
      );

      return txt(
        "Server error: " +
          (e?.message || "Unknown error"),
        500
      );
    }
  },
};
```

### بعد رفع الملف

اعمل **Commit** في GitHub، وانتظر Cloudflare حتى يظهر:

**Success / Deployed** ✅

ثم جرّب في المشغل:

```text
https://super-tv-api.super-stv.workers.dev/api/play.m3u8?id=b1_FHD
```

ومع إعدادات المشغل:

```text
User-Agent: stv2026
```

### نقطة مهمة جدًا

في `channels.json` قناة `b1_FHD` عندها:

```json
"headers": {
  "User-Agent": "",
  "Referer": "",
  "Origin": ""
}
```

لذلك الكود الجديد سيستخدم:

```text
User-Agent: stv2026
```

للمصدر تلقائيًا.

أما لو المصدر يحتاج **Referer أو Origin محدد**، فلازم نضعهما في `channels.json` للقناة نفسها.

**ولا تختبر الرابط بمجرد فتحه في Chrome**؛ لأن Chrome لن يرسل `stv2026`، وبالتالي سيعطيك `403 Forbidden` وهذا متوقع. الاختبار يكون من المشغل الذي ضبطت فيه الـ User-Agent.
