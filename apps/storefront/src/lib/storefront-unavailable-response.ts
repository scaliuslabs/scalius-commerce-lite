const NO_STORE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
  "Retry-After": "30",
} as const;

/** The page's own words: the storefront copy itself may be what failed to load. */
const UNAVAILABLE_COPY = {
  en: {
    title: "We'll be right back",
    message: "This page didn't load. Please try again in a moment.",
    retry: "Try again",
  },
  bn: {
    title: "একটু পরেই ফিরছি",
    message: "পেজটি লোড হয়নি। একটু পরে আবার চেষ্টা করুন।",
    retry: "আবার চেষ্টা করুন",
  },
} as const;

export interface StorefrontUnavailableOptions {
  /** The page's language (`bn`, `en-GB`, …): Bangla gets Bangla, everything else English. */
  lang?: string | null;
  /** The store's name, when the layout read succeeded. */
  storeName?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The 503 page a buyer sees when the storefront's data couldn't be read.
 * Self-contained (no theme, no scripts): neutral colours in light and dark,
 * the store's name when known, and Retry reloads the same address. A
 * page-specific `message` is English and shows only on English pages.
 */
export function storefrontDataUnavailableResponse(
  message?: string,
  options: StorefrontUnavailableOptions = {},
): Response {
  const lang = options.lang?.toLowerCase().startsWith("bn") ? "bn" : "en";
  const copy = UNAVAILABLE_COPY[lang];
  const safeMessage = escapeHtml(lang === "en" && message ? message : copy.message);
  const storeName = options.storeName?.trim() ? escapeHtml(options.storeName.trim()) : null;
  const title = escapeHtml(storeName ? `${copy.title} · ${options.storeName?.trim()}` : copy.title);

  return new Response(
    `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>${title}</title>
    <style>
      :root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1a1a1a; --muted: #5c5c5c; --btn: #1a1a1a; --btn-fg: #fff; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Bengali", sans-serif; }
      @media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #f2f2f2; --muted: #b0b0b0; --btn: #f2f2f2; --btn-fg: #161616; } }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); }
      main { width: min(92vw, 32rem); text-align: center; padding: 2rem 1rem; box-sizing: border-box; }
      .store { margin: 0 0 1rem; color: var(--muted); font-size: 1rem; font-weight: 600; }
      h1 { margin: 0 0 0.75rem; font-size: clamp(1.6rem, 4vw, 2.25rem); line-height: 1.25; }
      p { margin: 0 auto 1.5rem; color: var(--muted); font-size: 1rem; line-height: 1.6; }
      a { display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem; padding: 0 1.25rem; border-radius: 0.5rem; background: var(--btn); color: var(--btn-fg); text-decoration: none; font-weight: 600; }
      a:focus-visible { outline: 3px solid #3b82f6; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      ${storeName ? `<p class="store">${storeName}</p>` : ""}
      <h1>${escapeHtml(copy.title)}</h1>
      <p>${safeMessage}</p>
      <a href="">${copy.retry}</a>
    </main>
  </body>
</html>`,
    {
      status: 503,
      headers: NO_STORE_HEADERS,
    },
  );
}
