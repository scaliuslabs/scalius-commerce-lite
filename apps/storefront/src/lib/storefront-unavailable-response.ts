const NO_STORE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
  "Retry-After": "30",
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function storefrontDataUnavailableResponse(
  message = "Storefront data is temporarily unavailable. Please try again shortly.",
): Response {
  const safeMessage = escapeHtml(message);

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Storefront temporarily unavailable</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #111827; }
      main { width: min(92vw, 32rem); text-align: center; padding: 2rem; }
      h1 { margin: 0 0 0.75rem; font-size: clamp(1.6rem, 4vw, 2.25rem); line-height: 1.1; }
      p { margin: 0 auto 1.5rem; color: #4b5563; font-size: 1rem; line-height: 1.6; }
      a { display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem; padding: 0 1.25rem; border-radius: 0.5rem; background: #111827; color: #fff; text-decoration: none; font-weight: 600; }
      a:focus-visible { outline: 3px solid #60a5fa; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Storefront temporarily unavailable</h1>
      <p>${safeMessage}</p>
      <a href="/">Try again</a>
    </main>
  </body>
</html>`,
    {
      status: 503,
      headers: NO_STORE_HEADERS,
    },
  );
}
