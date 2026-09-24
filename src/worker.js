// ============================================================
// SUPER TV API - Cloudflare Worker
// ============================================================
// Main:
// https://super-tv-api.super-stv.workers.dev
//
// Play:
// /api/play.m3u8?id=CHANNEL_ID
//
// HLS:
// /api/hls?id=CHANNEL_ID&file=...
//
// Required bindings:
// KV:
//   DATA_KV
//
// Assets:
//   ASSETS
//
// Secret:
//   APP_SECRET
// ============================================================


// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
  APP_UA: "stv2026",

  PROXY_UA:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/153.0.0.0 Safari/537.36",

  CHANNELS_ASSET_PATHS: [
    "/data/channels.json",
    "/channels.json"
  ],

  RATE_LIMIT_SECONDS: 60,

  VIEWER_TTL: 60,

  MAX_REDIRECTS: 8,

  FETCH_TIMEOUT: 15000
};


// ============================================================
// BASIC HELPERS
// ============================================================

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}


function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}


function getClientIP(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}


function safeString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}


function normalizeId(value) {
  return safeString(value).toLowerCase();
}


function isValidHttpUrl(value) {
  try {
    const u = new URL(value);

    return (
      u.protocol === "http:" ||
      u.protocol === "https:"
    );
  } catch {
    return false;
  }
}


// ============================================================
// APP SECURITY
// ============================================================

function checkAppSecurity(request, env) {
  const ua = safeString(request.headers.get("User-Agent"));
  const appKey = safeString(request.headers.get("X-App-Key"));
  const secret = safeString(env.APP_SECRET);

  const uaOk = ua === CONFIG.APP_UA;
  const keyReceived = !!appKey;
  const secretConfigured = !!secret;

  console.log(
    "APP_SECURITY_CHECK:",
    JSON.stringify({
      uaOk,
      keyReceived,
      secretConfigured,
      keyLength: appKey.length,
      secretLength: secret.length
    })
  );

  if (!uaOk) {
    console.warn("APP SECURITY: BAD USER-AGENT");

    return {
      ok: false,
      response: json(
        {
          error: "Unauthorized",
          message: "Invalid User-Agent"
        },
        401
      )
    };
  }

  if (!secretConfigured) {
    console.error("APP SECURITY: APP_SECRET NOT CONFIGURED");

    return {
      ok: false,
      response: json(
        {
          error: "Server configuration error"
        },
        500
      )
    };
  }

  if (!keyReceived) {
    console.warn("APP SECURITY: KEY MISSING");

    return {
      ok: false,
      response: json(
        {
          error: "Unauthorized",
          message: "X-App-Key is required"
        },
        401
      )
    };
  }

  if (appKey !== secret) {
    console.warn("APP SECURITY: INVALID KEY");

    return {
      ok: false,
      response: json(
        {
          error: "Unauthorized",
          message: "Invalid app key"
        },
        401
      )
    };
  }

  console.log("APP SECURITY: OK");

  return {
    ok: true
  };
}


// ============================================================
// RATE LIMIT
// ============================================================

async function checkRateLimit(request, env) {
  if (!env.DATA_KV) {
    return true;
  }

  const ip = getClientIP(request);

  const key =
    `rate:${ip}:${Math.floor(Date.now() / 1000 / CONFIG.RATE_LIMIT_SECONDS)}`;

  try {
    const exists = await env.DATA_KV.get(key);

    if (exists) {
      console.warn("RATE LIMIT:", ip);
      return false;
    }

    await env.DATA_KV.put(
      key,
      "1",
      {
        expirationTtl: Math.max(
          60,
          CONFIG.RATE_LIMIT_SECONDS
        )
      }
    );

    return true;
  } catch (error) {
    console.error(
      "RATE LIMIT ERROR:",
      error?.message || error
    );

    return true;
  }
}


// ============================================================
// NORMALIZE CHANNEL
// ============================================================

function normalizeChannel(channel) {
  if (!channel || typeof channel !== "object") {
    return null;
  }

  const id =
    channel.id ??
    channel.ID ??
    channel.channel_id ??
    channel.channelId;

  const name =
    channel.name ??
    channel.title ??
    channel.channel_name ??
    channel.channelName ??
    "";

  const url =
    channel.url ??
    channel.URL ??
    channel.stream_url ??
    channel.streamUrl ??
    channel.play_url ??
    channel.playUrl ??
    channel.source ??
    channel.link ??
    channel.body ??
    "";

  if (
    id === undefined ||
    id === null ||
    safeString(id) === ""
  ) {
    return null;
  }

  if (!isValidHttpUrl(url)) {
    return null;
  }

  return {
    ...channel,

    id: safeString(id),

    name:
      safeString(name) ||
      safeString(id),

    url: safeString(url)
  };
}


// ============================================================
// EXTRACT CHANNEL ARRAY
// Supports:
//
// [
//   {...},
//   {...}
// ]
//
// {
//   "channels": [...]
// }
//
// {
//   "data": [...]
// }
//
// {
//   "results": [...]
// }
//
// {
//   "items": [...]
// }
// ============================================================

function extractChannels(data) {
  // ------------------------------------------
  // Direct array
  // ------------------------------------------

  if (Array.isArray(data)) {
    return data
      .map(normalizeChannel)
      .filter(Boolean);
  }


  // ------------------------------------------
  // Object
  // ------------------------------------------

  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data)
  ) {

    const possibleKeys = [
      "channels",
      "data",
      "results",
      "items",
      "list"
    ];

    for (const key of possibleKeys) {
      if (Array.isArray(data[key])) {

        const channels = data[key]
          .map(normalizeChannel)
          .filter(Boolean);

        if (channels.length > 0) {
          return channels;
        }
      }
    }


    // ----------------------------------------
    // Sometimes data itself is one channel
    // ----------------------------------------

    const oneChannel = normalizeChannel(data);

    if (oneChannel) {
      return [oneChannel];
    }
  }


  return [];
}


// ============================================================
// LOAD CHANNELS FROM KV
// ============================================================

async function loadChannelsFromKV(env) {
  if (!env.DATA_KV) {
    console.log("KV: NOT CONFIGURED");
    return [];
  }

  try {
    const raw = await env.DATA_KV.get("channels");

    if (!raw) {
      console.log("KV CHANNELS: EMPTY");
      return [];
    }

    console.log(
      "KV CHANNELS RAW LENGTH:",
      raw.length
    );

    let data;

    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error(
        "KV CHANNELS JSON ERROR:",
        error?.message || error
      );

      return [];
    }

    const channels = extractChannels(data);

    console.log(
      "KV CHANNELS PARSED:",
      channels.length
    );

    return channels;

  } catch (error) {

    console.error(
      "KV CHANNELS ERROR:",
      error?.message || error
    );

    return [];
  }
}


// ============================================================
// LOAD CHANNELS FROM ASSETS
// ============================================================

async function loadChannelsFromAssets(env) {

  console.log(
    "ASSETS CHECK:",
    JSON.stringify({
      configured: !!env.ASSETS
    })
  );


  if (!env.ASSETS) {
    console.error("ASSETS BINDING: MISSING");
    return [];
  }


  for (const path of CONFIG.CHANNELS_ASSET_PATHS) {

    try {

      const request = new Request(
        `https://assets.local${path}`,
        {
          method: "GET"
        }
      );

      const response =
        await env.ASSETS.fetch(request);


      console.log(
        "ASSETS RESPONSE:",
        JSON.stringify({
          path,
          status: response.status,
          ok: response.ok,
          contentType:
            response.headers.get("content-type") || ""
        })
      );


      if (!response.ok) {
        continue;
      }


      const raw = await response.text();


      console.log(
        "ASSETS BODY LENGTH:",
        JSON.stringify({
          path,
          length: raw.length
        })
      );


      // --------------------------------------
      // Debug first 500 chars
      // --------------------------------------

      console.log(
        "ASSETS BODY PREVIEW:",
        raw.substring(0, 500)
      );


      let data;

      try {

        data = JSON.parse(raw);

      } catch (error) {

        console.error(
          "ASSETS JSON PARSE ERROR:",
          JSON.stringify({
            path,
            error: error?.message || String(error)
          })
        );

        continue;
      }


      const channels =
        extractChannels(data);


      console.log(
        "ASSETS PARSED CHANNELS:",
        JSON.stringify({
          path,
          count: channels.length
        })
      );


      if (channels.length > 0) {

        const testHttp =
          channels.find(
            c =>
              normalizeId(c.id) ===
              "test_http"
          );

        console.log(
          "ASSETS TEST_HTTP:",
          JSON.stringify({
            found: !!testHttp,
            channel: testHttp
              ? {
                  id: testHttp.id,
                  name: testHttp.name,
                  url: testHttp.url
                }
              : null
          })
        );


        return channels;
      }

    } catch (error) {

      console.error(
        "ASSETS LOAD ERROR:",
        JSON.stringify({
          path,
          error: error?.message || String(error)
        })
      );
    }
  }


  console.error(
    "ASSETS CHANNELS: NOT FOUND"
  );

  return [];
}


// ============================================================
// LOAD ALL CHANNELS
// ============================================================

async function loadChannels(env) {

  // ------------------------------------------
  // KV first
  // ------------------------------------------

  const kvChannels =
    await loadChannelsFromKV(env);


  if (kvChannels.length > 0) {

    console.log(
      "CHANNEL SOURCE: KV",
      kvChannels.length
    );

    return kvChannels;
  }


  // ------------------------------------------
  // Assets fallback
  // ------------------------------------------

  const assetChannels =
    await loadChannelsFromAssets(env);


  if (assetChannels.length > 0) {

    console.log(
      "CHANNEL SOURCE: ASSETS",
      assetChannels.length
    );

    return assetChannels;
  }


  return [];
}


// ============================================================
// FIND CHANNEL
// ============================================================

async function findChannel(env, id) {

  const requestedId =
    safeString(id);


  console.log(
    "CHANNEL LOOKUP:",
    JSON.stringify({
      id: requestedId
    })
  );


  if (!requestedId) {
    return null;
  }


  const channels =
    await loadChannels(env);


  console.log(
    "CHANNEL SEARCH:",
    JSON.stringify({
      requestedId,
      channelsCount: channels.length
    })
  );


  const normalizedRequested =
    normalizeId(requestedId);


  const channel =
    channels.find(
      item =>
        normalizeId(item.id) ===
          normalizedRequested
    ) ||
    channels.find(
      item =>
        normalizeId(item.name) ===
          normalizedRequested
    );


  if (channel) {

    console.log(
      "CHANNEL FOUND:",
      JSON.stringify({
        id: channel.id,
        name: channel.name,
        url: channel.url
      })
    );

    return channel;
  }


  console.warn(
    "CHANNEL NOT FOUND:",
    requestedId
  );


  return null;
}


// ============================================================
// URL VALIDATION
// ============================================================

function validateTargetUrl(url) {

  if (!isValidHttpUrl(url)) {
    return {
      ok: false,
      reason: "Invalid URL"
    };
  }


  try {

    const parsed =
      new URL(url);


    // Block dangerous local/private targets

    const hostname =
      parsed.hostname.toLowerCase();


    const blockedHosts = [
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "::1"
    ];


    if (
      blockedHosts.includes(hostname)
    ) {
      return {
        ok: false,
        reason: "Blocked host"
      };
    }


    return {
      ok: true,
      url: parsed
    };

  } catch {

    return {
      ok: false,
      reason: "Invalid URL"
    };
  }
}


// ============================================================
// UPSTREAM HEADERS
// ============================================================

function buildUpstreamHeaders(
  target,
  mode = "normal"
) {

  const headers =
    new Headers();


  headers.set(
    "User-Agent",
    CONFIG.PROXY_UA
  );


  headers.set(
    "Accept",
    "*/*"
  );


  headers.set(
    "Accept-Language",
    "en-US,en;q=0.9"
  );


  headers.set(
    "Connection",
    "keep-alive"
  );


  if (mode === "normal") {

    headers.set(
      "Referer",
      `${target.origin}/`
    );

    headers.set(
      "Origin",
      target.origin
    );

  }


  if (mode === "no-referer") {

    // intentionally no Referer
    // intentionally no Origin

  }


  if (mode === "origin-referer") {

    headers.set(
      "Referer",
      target.origin + "/"
    );

    headers.set(
      "Origin",
      target.origin
    );
  }


  return headers;
}


// ============================================================
// MANUAL UPSTREAM FETCH
// ============================================================

async function fetchUpstream(
  initialUrl,
  options = {}
) {

  let currentUrl =
    new URL(initialUrl);


  let lastResponse = null;

  let lastError = null;


  for (
    let redirect = 0;
    redirect <= CONFIG.MAX_REDIRECTS;
    redirect++
  ) {

    console.log(
      "UPSTREAM REQUEST:",
      JSON.stringify({
        redirect,
        url: currentUrl.toString()
      })
    );


    const modes = [
      "normal",
      "no-referer",
      "origin-referer"
    ];


    for (const mode of modes) {

      try {

        const headers =
          buildUpstreamHeaders(
            currentUrl,
            mode
          );


        const controller =
          new AbortController();


        const timeout =
          setTimeout(
            () =>
              controller.abort(),
            options.timeout ||
              CONFIG.FETCH_TIMEOUT
          );


        let response;


        try {

          response =
            await fetch(
              currentUrl.toString(),
              {
                method:
                  options.method || "GET",

                headers,

                redirect: "manual",

                signal:
                  controller.signal,

                cf: {
                  cacheEverything: false
                }
              }
            );

        } finally {

          clearTimeout(timeout);
        }


        lastResponse =
          response;


        console.log(
          "UPSTREAM RESPONSE:",
          JSON.stringify({
            redirect,
            mode,
            status: response.status,
            url: currentUrl.toString(),
            location:
              response.headers.get(
                "location"
              ) || ""
          })
        );


        // ----------------------------------
        // Redirect
        // ----------------------------------

        if (
          response.status >= 300 &&
          response.status < 400
        ) {

          const location =
            response.headers.get(
              "Location"
            );


          if (!location) {

            console.warn(
              "REDIRECT WITHOUT LOCATION"
            );

            continue;
          }


          try {

            currentUrl =
              new URL(
                location,
                currentUrl
              );


            console.log(
              "UPSTREAM REDIRECT TO:",
              currentUrl.toString()
            );


            break;

          } catch (error) {

            console.error(
              "BAD REDIRECT LOCATION:",
              error?.message ||
                error
            );

            continue;
          }
        }


        // ----------------------------------
        // Success
        // ----------------------------------

        if (response.ok) {

          return {
            response,
            finalUrl: currentUrl
          };
        }


        // ----------------------------------
        // 403
        // ----------------------------------

        if (response.status === 403) {

          console.warn(
            "UPSTREAM 403:",
            JSON.stringify({
              mode,
              url:
                currentUrl.toString()
            })
          );

          continue;
        }


        // ----------------------------------
        // Other error
        // ----------------------------------

        console.warn(
          "UPSTREAM ERROR STATUS:",
          JSON.stringify({
            mode,
            status:
              response.status,
            url:
              currentUrl.toString()
          })
        );

      } catch (error) {

        lastError = error;

        console.error(
          "UPSTREAM FETCH ERROR:",
          JSON.stringify({
            mode,
            url:
              currentUrl.toString(),
            error:
              error?.message ||
              String(error)
          })
        );
      }
    }
  }


  // ----------------------------------------
  // Final fallback request
  // ----------------------------------------

  try {

    console.log(
      "UPSTREAM FINAL FALLBACK:",
      currentUrl.toString()
    );


    const response =
      await fetch(
        currentUrl.toString(),
        {
          method:
            options.method || "GET",

          headers: {
            "User-Agent":
              CONFIG.PROXY_UA,

            "Accept":
              "*/*"
          },

          redirect: "manual"
        }
      );


    lastResponse =
      response;


    if (response.ok) {

      return {
        response,
        finalUrl: currentUrl
      };
    }


  } catch (error) {

    lastError = error;

    console.error(
      "UPSTREAM FINAL FALLBACK ERROR:",
      error?.message ||
        error
    );
  }


  return {
    response: lastResponse,
    finalUrl: currentUrl,
    error: lastError
  };
}


// ============================================================
// GET RESPONSE BASE URL
// ============================================================

function getResponseBaseURL(
  response,
  fallbackUrl
) {

  try {

    if (
      response &&
      response.url
    ) {
      return new URL(
        response.url
      );
    }

  } catch {}

  try {

    return new URL(
      fallbackUrl
    );

  } catch {

    return null;
  }
}


// ============================================================
// HLS URL RESOLUTION
// ============================================================

function resolveHLSUrl(
  value,
  baseUrl
) {

  try {

    return new URL(
      value,
      baseUrl
    ).toString();

  } catch {

    return null;
  }
}


// ============================================================
// REWRITE HLS MANIFEST
// ============================================================

function rewriteHLSManifest(
  manifest,
  baseUrl,
  env
) {

  const lines =
    manifest.split(/\r?\n/);


  const output = [];


  for (let i = 0; i < lines.length; i++) {

    const line =
      lines[i];


    // --------------------------------------
    // EXT-X-KEY URI
    // --------------------------------------

    if (
      line.startsWith(
        "#EXT-X-KEY:"
      )
    ) {

      const rewritten =
        line.replace(
          /URI="([^"]+)"/i,
          (match, uri) => {

            const absolute =
              resolveHLSUrl(
                uri,
                baseUrl
              );


            if (!absolute) {
              return match;
            }


            const proxy =
              buildProxyUrl(
                absolute,
                env
              );


            return `URI="${proxy}"`;
          }
        );


      output.push(
        rewritten
      );

      continue;
    }


    // --------------------------------------
    // EXT-X-MAP URI
    // --------------------------------------

    if (
      line.startsWith(
        "#EXT-X-MAP:"
      )
    ) {

      const rewritten =
        line.replace(
          /URI="([^"]+)"/i,
          (match, uri) => {

            const absolute =
              resolveHLSUrl(
                uri,
                baseUrl
              );


            if (!absolute) {
              return match;
            }


            const proxy =
              buildProxyUrl(
                absolute,
                env
              );


            return `URI="${proxy}"`;
          }
        );


      output.push(
        rewritten
      );

      continue;
    }


    // --------------------------------------
    // Comment / EXT tags
    // --------------------------------------

    if (
      line.startsWith("#")
    ) {

      output.push(line);

      continue;
    }


    // --------------------------------------
    // URI
    // --------------------------------------

    const trimmed =
      line.trim();


    if (!trimmed) {

      output.push("");

      continue;
    }


    const absolute =
      resolveHLSUrl(
        trimmed,
        baseUrl
      );


    if (!absolute) {

      output.push(line);

      continue;
    }


    const proxy =
      buildProxyUrl(
        absolute,
        env
      );


    output.push(
      proxy
    );
  }


  return output.join("\n");
}


// ============================================================
// BUILD INTERNAL PROXY URL
// ============================================================

function buildProxyUrl(
  targetUrl,
  env
) {

  const origin =
    env.__REQUEST_ORIGIN ||
    "";


  if (!origin) {
    return targetUrl;
  }


  return (
    `${origin}/api/hls?url=` +
    encodeURIComponent(targetUrl)
  );
}


// ============================================================
// VIEWERS
// ============================================================

async function registerViewer(
  env,
  channelId,
  request
) {

  if (!env.DATA_KV) {
    return;
  }


  try {

    const ip =
      getClientIP(request);


    const safeChannel =
      encodeURIComponent(
        safeString(channelId)
      );


    const safeIP =
      encodeURIComponent(ip);


    const key =
      `viewer:${safeChannel}:${safeIP}`;


    await env.DATA_KV.put(
      key,
      JSON.stringify({
        channelId:
          safeString(channelId),

        ip,

        timestamp:
          Date.now()
      }),
      {
        expirationTtl:
          Math.max(
            60,
            CONFIG.VIEWER_TTL
          )
      }
    );

  } catch (error) {

    console.error(
      "VIEWER REGISTER ERROR:",
      error?.message ||
        error
    );
  }
}


// ============================================================
// GET VIEWERS
// ============================================================

async function getViewerCount(
  env,
  channelId
) {

  if (!env.DATA_KV) {
    return 0;
  }


  try {

    const prefix =
      `viewer:${encodeURIComponent(
        safeString(channelId)
      )}:`;


    let cursor =
      undefined;


    let count = 0;


    do {

      const result =
        await env.DATA_KV.list({
          prefix,
          cursor,
          limit: 1000
        });


      count +=
        result.keys.length;


      cursor =
        result.list_complete
          ? undefined
          : result.cursor;

    } while (cursor);


    return count;

  } catch (error) {

    console.error(
      "VIEWER COUNT ERROR:",
      error?.message ||
        error
    );

    return 0;
  }
}


// ============================================================
// PLAY API
// ============================================================

async function playApi(
  request,
  env
) {

  const url =
    new URL(request.url);


  const id =
    url.searchParams.get("id");


  if (!id) {

    return json(
      {
        error:
          "Missing channel id"
      },
      400
    );
  }


  const channel =
    await findChannel(
      env,
      id
    );


  if (!channel) {

    return json(
      {
        error:
          "Channel not found",

        id
      },
      404
    );
  }


  const validation =
    validateTargetUrl(
      channel.url
    );


  if (!validation.ok) {

    return json(
      {
        error:
          "Invalid channel URL",

        id,

        reason:
          validation.reason
      },
      400
    );
  }


  const sourceUrl =
    validation.url;


  console.log(
    "PLAY SOURCE:",
    JSON.stringify({
      id,
      name:
        channel.name,
      url:
        sourceUrl.toString()
    })
  );


  const upstream =
    await fetchUpstream(
      sourceUrl
    );


  const response =
    upstream.response;


  if (!response) {

    return json(
      {
        error:
          "Upstream request failed",

        id
      },
      502
    );
  }


  if (!response.ok) {

    console.error(
      "PLAY UPSTREAM FAILED:",
      JSON.stringify({
        id,

        status:
          response.status,

        finalUrl:
          upstream.finalUrl
            ?.toString() || "",

        error:
          upstream.error
            ?.message ||
          ""
      })
    );


    return json(
      {
        error:
          "Upstream error",

        status:
          response.status,

        id
      },
      502
    );
  }


  await registerViewer(
    env,
    id,
    request
  );


  const contentType =
    response.headers.get(
      "content-type"
    ) || "";


  const finalBase =
    getResponseBaseURL(
      response,
      upstream.finalUrl ||
        sourceUrl
    );


  // ----------------------------------------
  // HLS manifest
  // ----------------------------------------

  if (
    contentType.includes(
      "mpegurl"
    ) ||
    contentType.includes(
      "application/vnd.apple.mpegurl"
    ) ||
    sourceUrl.pathname
      .toLowerCase()
      .endsWith(".m3u8")
  ) {

    const body =
      await response.text();


    const rewritten =
      rewriteHLSManifest(
        body,
        finalBase,
        env
      );


    return new Response(
      rewritten,
      {
        status: 200,

        headers: {
          "content-type":
            "application/vnd.apple.mpegurl",

          "cache-control":
            "no-store, no-cache, must-revalidate",

          "access-control-allow-origin":
            "*",

          "access-control-allow-methods":
            "GET, HEAD, OPTIONS",

          "access-control-allow-headers":
            "*"
        }
      }
    );
  }


  // ----------------------------------------
  // Non HLS
  // ----------------------------------------

  return new Response(
    response.body,
    {
      status:
        response.status,

      headers: {
        "content-type":
          contentType ||
          "application/octet-stream",

        "cache-control":
          "no-store",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}


// ============================================================
// HLS API
// ============================================================

async function hlsApi(
  request,
  env
) {

  const url =
    new URL(request.url);


  let target =
    url.searchParams.get(
      "url"
    );


  if (!target) {

    const file =
      url.searchParams.get(
        "file"
      );


    if (file) {
      target = file;
    }
  }


  if (!target) {

    return json(
      {
        error:
          "Missing url"
      },
      400
    );
  }


  const validation =
    validateTargetUrl(
      target
    );


  if (!validation.ok) {

    return json(
      {
        error:
          "Invalid URL",

        reason:
          validation.reason
      },
      400
    );
  }


  const targetUrl =
    validation.url;


  console.log(
    "HLS TARGET:",
    targetUrl.toString()
  );


  const upstream =
    await fetchUpstream(
      targetUrl
    );


  const response =
    upstream.response;


  if (!response) {

    return json(
      {
        error:
          "Upstream failed"
      },
      502
    );
  }


  if (!response.ok) {

    return json(
      {
        error:
          "Upstream error",

        status:
          response.status,

        url:
          upstream.finalUrl
            ?.toString() || ""
      },
      502
    );
  }


  const contentType =
    response.headers.get(
      "content-type"
    ) || "";


  const finalBase =
    getResponseBaseURL(
      response,
      upstream.finalUrl ||
        targetUrl
    );


  if (
    contentType.includes(
      "mpegurl"
    ) ||
    contentType.includes(
      "application/vnd.apple.mpegurl"
    ) ||
    targetUrl.pathname
      .toLowerCase()
      .endsWith(".m3u8")
  ) {

    const body =
      await response.text();


    const rewritten =
      rewriteHLSManifest(
        body,
        finalBase,
        env
      );


    return new Response(
      rewritten,
      {
        status: 200,

        headers: {
          "content-type":
            "application/vnd.apple.mpegurl",

          "cache-control":
            "no-store",

          "access-control-allow-origin":
            "*",

          "access-control-allow-methods":
            "GET, HEAD, OPTIONS",

          "access-control-allow-headers":
            "*"
        }
      }
    );
  }


  return new Response(
    response.body,
    {
      status:
        response.status,

      headers: {
        "content-type":
          contentType ||
          "application/octet-stream",

        "cache-control":
          "no-store",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}


// ============================================================
// PROXY M3U8 API
// ============================================================

async function proxyM3u8Api(
  request,
  env
) {

  const url =
    new URL(request.url);


  const target =
    url.searchParams.get(
      "url"
    );


  if (!target) {

    return json(
      {
        error:
          "Missing url"
      },
      400
    );
  }


  const validation =
    validateTargetUrl(
      target
    );


  if (!validation.ok) {

    return json(
      {
        error:
          "Invalid URL",

        reason:
          validation.reason
      },
      400
    );
  }


  const targetUrl =
    validation.url;


  const upstream =
    await fetchUpstream(
      targetUrl
    );


  const response =
    upstream.response;


  if (!response) {

    return json(
      {
        error:
          "Upstream failed"
      },
      502
    );
  }


  if (!response.ok) {

    return json(
      {
        error:
          "Upstream error",

        status:
          response.status
      },
      502
    );
  }


  const body =
    await response.text();


  const finalBase =
    getResponseBaseURL(
      response,
      upstream.finalUrl ||
        targetUrl
    );


  const rewritten =
    rewriteHLSManifest(
      body,
      finalBase,
      env
    );


  return new Response(
    rewritten,
    {
      status: 200,

      headers: {
        "content-type":
          "application/vnd.apple.mpegurl",

        "cache-control":
          "no-store",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}


// ============================================================
// GENERIC PROXY
// ============================================================

async function proxyApi(
  request,
  env
) {

  const url =
    new URL(request.url);


  const target =
    url.searchParams.get(
      "url"
    );


  if (!target) {

    return json(
      {
        error:
          "Missing url"
      },
      400
    );
  }


  const validation =
    validateTargetUrl(
      target
    );


  if (!validation.ok) {

    return json(
      {
        error:
          "Invalid URL",

        reason:
          validation.reason
      },
      400
    );
  }


  const upstream =
    await fetchUpstream(
      validation.url
    );


  const response =
    upstream.response;


  if (!response) {

    return json(
      {
        error:
          "Upstream failed"
      },
      502
    );
  }


  return new Response(
    response.body,
    {
      status:
        response.status,

      headers: {
        "content-type":
          response.headers.get(
            "content-type"
          ) ||
          "application/octet-stream",

        "cache-control":
          "no-store",

        "access-control-allow-origin":
          "*",

        "access-control-allow-methods":
          "GET, HEAD, OPTIONS",

        "access-control-allow-headers":
          "*"
      }
    }
  );
}


// ============================================================
// TS / SEGMENT API
// ============================================================

async function tsApi(
  request,
  env
) {

  return proxyApi(
    request,
    env
  );
}


// ============================================================
// CHANNELS API
// ============================================================

async function channelsApi(
  request,
  env
) {

  const channels =
    await loadChannels(
      env
    );


  return json({
    count:
      channels.length,

    channels:
      channels.map(
        channel => ({
          id:
            channel.id,

          name:
            channel.name,

          url:
            channel.url
        })
      )
  });
}


// ============================================================
// VIEWERS API
// ============================================================

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
        error:
          "Missing id"
      },
      400
    );
  }


  const count =
    await getViewerCount(
      env,
      id
    );


  return json({
    id,
    viewers:
      count
  });
}


// ============================================================
// SAVE CHANNEL
// ============================================================

async function saveApi(
  request,
  env
) {

  if (!env.DATA_KV) {

    return json(
      {
        error:
          "KV not configured"
      },
      500
    );
  }


  let body;

  try {

    body =
      await request.json();

  } catch {

    return json(
      {
        error:
          "Invalid JSON"
      },
      400
    );
  }


  const channel =
    normalizeChannel(
      body
    );


  if (!channel) {

    return json(
      {
        error:
          "Invalid channel format",

        expected: {
          id:
            "channel_id",

          name:
            "Channel name",

          url:
            "https://example.com/live.m3u8"
        }
      },
      400
    );
  }


  const current =
    await loadChannelsFromKV(
      env
    );


  const index =
    current.findIndex(
      item =>
        normalizeId(item.id) ===
        normalizeId(channel.id)
    );


  if (index >= 0) {

    current[index] =
      channel;

  } else {

    current.push(
      channel
    );
  }


  await env.DATA_KV.put(
    "channels",
    JSON.stringify(
      current
    )
  );


  return json({
    success: true,

    channel
  });
}


// ============================================================
// ADMIN
// ============================================================

async function adminApi(
  request,
  env
) {

  const channels =
    await loadChannels(
      env
    );


  return json({
    success: true,

    channelsCount:
      channels.length,

    kvConfigured:
      !!env.DATA_KV,

    assetsConfigured:
      !!env.ASSETS,

    secretConfigured:
      !!env.APP_SECRET
  });
}


// ============================================================
// HEALTH
// ============================================================

async function healthApi(
  request,
  env
) {

  return json({
    ok: true,

    service:
      "super-tv-api",

    time:
      new Date().toISOString(),

    kv:
      !!env.DATA_KV,

    assets:
      !!env.ASSETS,

    secret:
      !!env.APP_SECRET
  });
}


// ============================================================
// ROOT
// ============================================================

function rootApi() {

  return json({
    name:
      "SUPER TV API",

    status:
      "online",

    endpoints: [
      "/health",
      "/api/channels",
      "/api/play.m3u8?id=CHANNEL_ID",
      "/api/hls?url=URL",
      "/api/proxy?url=URL",
      "/api/viewers?id=CHANNEL_ID"
    ]
  });
}


// ============================================================
// OPTIONS / CORS
// ============================================================

function optionsResponse() {

  return new Response(
    null,
    {
      status: 204,

      headers: {
        "access-control-allow-origin":
          "*",

        "access-control-allow-methods":
          "GET, POST, OPTIONS",

        "access-control-allow-headers":
          "*",

        "access-control-max-age":
          "86400"
      }
    }
  );
}


// ============================================================
// MAIN FETCH
// ============================================================

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(request.url);


    // --------------------------------------
    // CORS preflight
    // --------------------------------------

    if (
      request.method ===
      "OPTIONS"
    ) {

      return optionsResponse();
    }


    // --------------------------------------
    // Store request origin
    // --------------------------------------

    env.__REQUEST_ORIGIN =
      url.origin;


    // --------------------------------------
    // Public routes
    // --------------------------------------

    if (
      url.pathname ===
      "/health"
    ) {

      return healthApi(
        request,
        env
      );
    }


    if (
      url.pathname ===
      "/"
    ) {

      return rootApi();
    }


    // --------------------------------------
    // Security for API
    // --------------------------------------

    if (
      url.pathname.startsWith(
        "/api/"
      )
    ) {

      const security =
        checkAppSecurity(
          request,
          env
        );


      if (!security.ok) {
        return security.response;
      }


      const rateOk =
        await checkRateLimit(
          request,
          env
        );


      if (!rateOk) {

        return json(
          {
            error:
              "Too many requests"
          },
          429
        );
      }
    }


    // --------------------------------------
    // Routes
    // --------------------------------------

    if (
      url.pathname ===
      "/api/play.m3u8"
    ) {

      return playApi(
        request,
        env
      );
    }


    if (
      url.pathname ===
      "/api/hls"
    ) {

      return hlsApi(
        request,
        env
      );
    }


    if (
      url.pathname ===
      "/api/playlist.m3u8"
    ) {

      return proxyM3u8Api(
        request,
        env
      );
    }


    if (
      url.pathname ===
      "/api/proxy"
    ) {

      return proxyApi(
        request,
        env
      );
    }


    if (
      url.pathname ===
      "/api/ts"
    ) {

      return tsApi(
        request,
        env
      );
    }


    if (
      url.pathname ===
      "/api/channels"
    ) {

      return channelsApi(
        request,
        env
      );
    }


    if (
      url.pathname ===
      "/api/viewers"
    ) {

      return viewersApi(
        request,
        env
      );
    }


    if (
      url.pathname ===
      "/api/save"
    ) {

      return saveApi(
        request,
        env
      );
    }


    if (
      url.pathname ===
      "/api/admin"
    ) {

      return adminApi(
        request,
        env
      );
    }


    // --------------------------------------
    // Static assets fallback
    // --------------------------------------

    if (env.ASSETS) {

      try {

        const assetResponse =
          await env.ASSETS.fetch(
            request
          );


        if (
          assetResponse.status !==
          404
        ) {

          return assetResponse;
        }

      } catch (error) {

        console.error(
          "ASSET FALLBACK ERROR:",
          error?.message ||
            error
        );
      }
    }


    // --------------------------------------
    // 404
    // --------------------------------------

    return json(
      {
        error:
          "Not Found",

        path:
          url.pathname
      },
      404
    );
  }
};
