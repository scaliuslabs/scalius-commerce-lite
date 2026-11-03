// The continuation pages' setup (`/checkout/continue/<id>`, which the API
// issues, and `/agent/continue/<id>`): everything awaited and every response
// header and status, called from each page's OWN frontmatter. Production
// streams a page and sends its headers and status before a child
// component's frontmatter runs, so none of this may live in the shared
// document (components/continuation/ContinuationDocument.astro).
import { readAgentContinuationCookie } from "@/lib/agent-continuation-cookie";
import { getRuntimeStoreLanguage } from "@/lib/api/runtime";
import { getLayoutData } from "@/lib/api";
import { colorSchemeBootScript, colorSchemeScriptSource } from "@/lib/color-scheme";
import { continuationLanguage } from "@/lib/continuation-copy";
import { cardPageCsp } from "@/lib/middleware-helper/csp-handler";
import { setOwnCsp } from "@/lib/middleware-helper/own-csp";
import { resolveRequestTheme } from "@/lib/storefront-theme-context";
import { themePaint, type ThemePaint } from "@/lib/theme-paint";

const CONTINUATION_ID = /^acn_[A-Za-z0-9_-]{20}$/;

/** What the shared document draws. */
export interface ContinuationPage {
  language: ReturnType<typeof continuationLanguage>;
  /** The continuation this browser holds (its cookie names it); null: the page is a 404. */
  continuationId: string | null;
  paint: ThemePaint;
  /** The theme editor's preview: the canvas shows the colours it edits. */
  preview: boolean;
}

/**
 * Resolves the page and sets its response: no caching, no referrer, no
 * indexing, the strict card policy (the colour scheme's script by its hash),
 * and 404 for a continuation this browser does not hold.
 */
export async function prepareContinuationPage(astro: {
  params: Record<string, string | undefined>;
  request: Request;
  locals: object;
  response: { headers: Headers; status: number };
}): Promise<ContinuationPage> {
  // The middleware already resolved the store language in its one layout read.
  const language = continuationLanguage(getRuntimeStoreLanguage());
  const id = astro.params.continuationId?.trim() ?? "";
  const continuationId = CONTINUATION_ID.test(id)
    && readAgentContinuationCookie(astro.request.headers.get("cookie"), id) === id ? id : null;
  // The store's theme: its tokens and colour scheme, as every page paints them
  // (the layout read is the request's one, shared with the middleware).
  const requestTheme = await resolveRequestTheme(astro, await getLayoutData().catch(() => null));
  const paint = themePaint(requestTheme.theme, requestTheme.resolved);
  const preview = requestTheme.preview !== null;
  // This page allows no inline script but the colour scheme's own, by its hash.
  const scriptSource = await colorSchemeScriptSource(colorSchemeBootScript(paint.colorScheme, !preview));

  astro.response.headers.set("Cache-Control", "private, no-store");
  astro.response.headers.set("Referrer-Policy", "no-referrer");
  astro.response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  setOwnCsp(astro.response.headers, cardPageCsp(scriptSource));
  if (!continuationId) astro.response.status = 404;
  return { language, continuationId, paint, preview };
}
