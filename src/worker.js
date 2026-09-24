// ============================================================
// FETCH UPSTREAM - MANUAL REDIRECT
// ============================================================

async function fetchUpstream(
  target,
  request
) {
  const MAX_REDIRECTS = 5;

  let currentUrl = target;

  const range =
    request.headers.get("Range");

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount++
  ) {

    let parsed;

    try {
      parsed =
        new URL(currentUrl);
    } catch {
      throw new Error(
        "Invalid upstream URL: " +
        currentUrl
      );
    }

    // --------------------------------------------------------
    // HEADERS
    // --------------------------------------------------------

    const headers =
      new Headers();

    headers.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/153.0.0.0 Safari/537.36"
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
    // REFERER
    // --------------------------------------------------------

    // نحافظ على Referer الخاص بالدومين الأصلي
    // إلا لو المصدر ostora كما كان في الكود القديم
    if (
      parsed.hostname
        .toLowerCase()
        .includes("ostora")
    ) {
      headers.set(
        "Referer",
        "https://ostora.pages.dev/"
      );
    } else {
      headers.set(
        "Referer",
        `${parsed.protocol}//${parsed.hostname}/`
      );
    }

    // --------------------------------------------------------
    // RANGE
    // --------------------------------------------------------

    if (range) {
      headers.set(
        "Range",
        range
      );
    }

    // --------------------------------------------------------
    // LOG REQUEST
    // --------------------------------------------------------

    console.log(
      "UPSTREAM FETCH:",
      JSON.stringify({
        redirectCount,
        url: currentUrl,
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: parsed.port || "",
        path:
          parsed.pathname
            .substring(0, 250)
      })
    );

    // --------------------------------------------------------
    // FETCH
    // --------------------------------------------------------

    let response;

    try {
      response =
        await fetch(
          currentUrl,
          {
            method:
              request.method ===
              "HEAD"
                ? "HEAD"
                : "GET",

            redirect:
              "manual",

            headers
          }
        );
    } catch (e) {

      console.error(
        "UPSTREAM FETCH ERROR:",
        JSON.stringify({
          url: currentUrl,
          message:
            e?.message ||
            String(e)
        })
      );

      throw e;
    }

    // --------------------------------------------------------
    // RESPONSE LOG
    // --------------------------------------------------------

    console.log(
      "UPSTREAM RESPONSE:",
      JSON.stringify({
        redirectCount,
        status:
          response.status,
        statusText:
          response.statusText,
        responseUrl:
          response.url ||
          currentUrl
      })
    );

    // --------------------------------------------------------
    // REDIRECT
    // --------------------------------------------------------

    if (
      response.status >= 300 &&
      response.status < 400
    ) {

      const location =
        response.headers.get(
          "Location"
        );

      console.log(
        "UPSTREAM REDIRECT:",
        JSON.stringify({
          redirectCount,
          status:
            response.status,
          location:
            location
              ? location.substring(
                  0,
                  500
                )
              : null
        })
      );

      // لا يوجد Location
      if (!location) {
        console.warn(
          "REDIRECT WITHOUT LOCATION"
        );

        return response;
      }

      let nextUrl;

      try {
        nextUrl =
          new URL(
            location,
            currentUrl
          ).toString();
      } catch (e) {

        console.error(
          "REDIRECT URL ERROR:",
          e?.message ||
            String(e)
        );

        return response;
      }

      let nextParsed;

      try {
        nextParsed =
          new URL(
            nextUrl
          );
      } catch {
        return response;
      }

      console.log(
        "UPSTREAM REDIRECT TARGET:",
        JSON.stringify({
          redirectCount:
            redirectCount + 1,

          protocol:
            nextParsed.protocol,

          host:
            nextParsed.hostname,

          port:
            nextParsed.port || "",

          path:
            nextParsed.pathname
              .substring(
                0,
                300
              )
        })
      );

      currentUrl =
        nextUrl;

      continue;
    }

    // --------------------------------------------------------
    // FINAL RESPONSE
    // --------------------------------------------------------

    console.log(
      "UPSTREAM FINAL:",
      JSON.stringify({
        redirects:
          redirectCount,

        status:
          response.status,

        url:
          response.url ||
          currentUrl,

        contentType:
          response.headers.get(
            "content-type"
          ) || "",

        contentLength:
          response.headers.get(
            "content-length"
          ) || ""
      })
    );

    return response;
  }

  // ----------------------------------------------------------
  // TOO MANY REDIRECTS
  // ----------------------------------------------------------

  console.error(
    "UPSTREAM TOO MANY REDIRECTS:",
    JSON.stringify({
      target,
      maxRedirects:
        MAX_REDIRECTS
    })
  );

  throw new Error(
    "Too many upstream redirects"
  );
}
