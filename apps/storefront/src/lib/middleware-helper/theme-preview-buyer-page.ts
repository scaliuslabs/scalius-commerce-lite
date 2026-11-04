// A buyer's own page (checkout, account, receipts, tracking...) never draws a
// draft and is never framed by the dashboard, whatever the request: the
// page's theme resolution and its frame policy both skip the preview there
// (`resolveRequestTheme`, the middleware's `themePreviewFrameAncestors`).
// This notice only tells the merchant so: a navigation there under a live
// preview, in a tab or in the theme editor's frame, answers it in place of
// the page, with a way home (and, in a tab, out of the preview). A request
// without the preview cookie (every buyer's) is never checked; a preview the
// API says has ended, or gave no answer about, renders the page as usual.
import { resolveThemePreview, type LayoutData } from "@/lib/api";
import { getRuntimeDashboardUrl } from "@/lib/api/runtime";
import { PRIVATE_NO_STORE_CACHE_CONTROL } from "@/lib/cache-policy";
import { storefrontLanguage } from "@/lib/storefront-language";
import { readThemePreviewCookie } from "@/lib/theme-preview-cookie";
import { themePreviewCopy } from "@/lib/theme-preview-copy";
import { isBuyerOwnPagePath } from "@/lib/theme-preview-route";
import { themeEditorOrigin } from "@scalius/shared/theme-editor-bridge";

/** Fetch destinations of a page navigation; a script's fetch of an endpoint is never answered here. */
const NAVIGATION_DESTINATIONS = new Set(["document", "iframe", "frame"]);

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The notice for a buyer's page requested under a live preview, or null to
 * render the request as usual. Its policy names who may frame it (the
 * dashboard), so the transport adds no `X-Frame-Options` over it.
 */
export async function themePreviewBuyerPageNotice(
  context: { request: Request; url: URL },
  layout: Promise<LayoutData | null>,
): Promise<Response | null> {
  const { request, url } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const token = readThemePreviewCookie(request.headers.get("cookie"));
  if (!token || !isBuyerOwnPagePath(url.pathname)) return null;
  const destination = request.headers.get("sec-fetch-dest");
  if (destination && !NAVIGATION_DESTINATIONS.has(destination)) return null;

  const [layoutData, resolution] = await Promise.all([layout, resolveThemePreview(token)]);
  if (resolution.state !== "live") return null;

  const copy = themePreviewCopy(layoutData?.storefrontCopy?.languageCode);
  const lang = storefrontLanguage(layoutData?.storefrontCopy?.languageCode);
  // Leaving the preview is offered in a tab of its own; the editor's frame keeps its session.
  const exit = destination === "document"
    ? `<form method="post" action="/theme-preview/exit"><button type="submit">${escapeHtml(copy.exitPreview)}</button></form>`
    : "";
  const html = `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>${escapeHtml(copy.buyerPageTitle)}</title>
    <style>
      :root { color-scheme: light dark; --bg: #f4f4f5; --card: #fff; --fg: #18181b; --muted: #52525b; --line: #d4d4d8; --btn: #18181b; --btn-fg: #fff; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans Bengali", sans-serif; }
      @media (prefers-color-scheme: dark) { :root { --bg: #111113; --card: #18181b; --fg: #f4f4f5; --muted: #a1a1aa; --line: #3f3f46; --btn: #f4f4f5; --btn-fg: #18181b; } }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.25rem; box-sizing: border-box; background: var(--bg); color: var(--fg); }
      main { width: min(100%, 32rem); border: 1px solid var(--line); border-radius: .8rem; background: var(--card); padding: 1.5rem; }
      h1 { margin: 0; font-size: 1.2rem; line-height: 1.4; }
      p { margin: .6rem 0 1.25rem; color: var(--muted); font-size: .95rem; line-height: 1.55; }
      .actions { display: flex; flex-wrap: wrap; gap: .6rem; }
      a, button { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0 1.1rem; border-radius: .5rem; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
      a { background: var(--btn); color: var(--btn-fg); border: 1px solid var(--btn); }
      button { background: transparent; color: var(--fg); border: 1px solid var(--line); }
      form { margin: 0; }
      a:focus-visible, button:focus-visible { outline: 3px solid #3b82f6; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(copy.buyerPageTitle)}</h1>
      <p>${escapeHtml(copy.buyerPage)}</p>
      <div class="actions">
        <a href="/">${escapeHtml(copy.openHome)}</a>
        ${exit}
      </div>
    </main>
  </body>
</html>`;

  const dashboard = themeEditorOrigin(getRuntimeDashboardUrl());
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL,
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  // The notice answers before the page policy runs, so it states its own: no
  // script at all, and the store's own pages and the editor's frame may show it.
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'${dashboard ? ` ${dashboard}` : ""}`,
  );
  return new Response(request.method === "HEAD" ? null : html, { status: 403, headers });
}
