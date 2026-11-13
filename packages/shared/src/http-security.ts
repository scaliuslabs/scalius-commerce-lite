const LOCAL_DEVELOPMENT_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

const HSTS_VALUE = "max-age=31536000; includeSubDomains";

function isLocalDevelopmentUrl(url: URL): boolean {
  return LOCAL_DEVELOPMENT_HOSTNAMES.has(url.hostname)
    || url.hostname.endsWith(".localhost");
}

/**
 * Redirect public plaintext requests before auth, cache, or application work.
 * Loopback HTTP remains available for local development.
 */
export function redirectPlaintextRequest(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || isLocalDevelopmentUrl(url)) {
    return null;
  }

  url.protocol = "https:";
  return new Response(null, {
    status: 308,
    headers: {
      "Cache-Control": "no-store",
      Location: url.toString(),
    },
  });
}

/**
 * The policy of every answer that is data, never a page: the API's JSON and
 * media, a plugin route's response and the store's app proxy that passes it
 * on. Nothing in it runs, loads or is framed (an uploaded SVG opened on its
 * own included). One constant, so no answer's content can shape it.
 */
export const ANSWER_CSP = "default-src 'none'; frame-ancestors 'none'";

/** No document may use the camera, microphone or location. */
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()";

/** The barcode scanner's document: its own camera, nothing else. */
export const CAMERA_PERMISSIONS_POLICY = "camera=(self), microphone=(), geolocation=()";

export type FrameProtection = "deny" | "same-origin" | "preserve";

/**
 * Apply browser transport and isolation headers to the final response. HSTS is
 * emitted only for HTTPS responses because browsers ignore it over plaintext.
 * `contentSecurityPolicy` is the policy of a response that states none (a
 * page always states its own); `permissionsPolicy` replaces the default for a
 * document that needs a device.
 */
export function applyBaselineSecurityHeaders(
  request: Request,
  response: Response,
  options: {
    frameProtection?: FrameProtection;
    contentSecurityPolicy?: string;
    permissionsPolicy?: string;
  } = {},
): Response {
  // A WebSocket handshake (the realtime hub): its 101 cannot be rebuilt
  // without losing the socket, and it carries no document to protect.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  const url = new URL(request.url);

  if (url.protocol === "https:" && !isLocalDevelopmentUrl(url)) {
    headers.set("Strict-Transport-Security", HSTS_VALUE);
  }

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", options.permissionsPolicy ?? PERMISSIONS_POLICY);
  if (options.contentSecurityPolicy && !headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", options.contentSecurityPolicy);
  }

  const frameProtection = options.frameProtection ?? "preserve";
  if (frameProtection === "deny") {
    headers.set("X-Frame-Options", "DENY");
  } else if (frameProtection === "same-origin") {
    headers.set("X-Frame-Options", "SAMEORIGIN");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Content-Security-Policy: inline scripts are allowed by their SHA-256 hash,
// never by 'unsafe-inline'. A page's inline scripts are fixed by its build
// (the dashboard's shell) or by the server that renders it (the storefront),
// so their hashes are known before the body is sent and stay valid in any
// cache that keeps the body with its headers. Nonces could not: a cached page
// would replay its nonce to every visitor.
// ---------------------------------------------------------------------------

/** Merchant-authored video the storefront shows and the dashboard's editor previews (video-embed.ts). */
export const VIDEO_EMBED_FRAME_SOURCES = ["https://www.youtube-nocookie.com", "https://player.vimeo.com"] as const;

/**
 * The script a printable document opened from the dashboard runs to print
 * itself (the barcode labels). A document the dashboard opens (a blob, an
 * about:blank window) keeps the dashboard's policy, so the policy names it.
 */
export const PRINT_ON_LOAD_SCRIPT = 'addEventListener("load",()=>print())';

/** One `<script>` element of an HTML text: its attributes (lower-case names) and its body. */
export interface HtmlScriptBlock {
  attributes: ReadonlyMap<string, string>;
  body: string;
}

const SCRIPT_BLOCK = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script[\s/>]/gi;
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// The HTML standard's JavaScript MIME type essences, and `module`.
const SCRIPT_TYPES = new Set([
  "", "module", "application/ecmascript", "application/javascript", "application/x-ecmascript",
  "application/x-javascript", "text/ecmascript", "text/javascript", "text/javascript1.0",
  "text/javascript1.1", "text/javascript1.2", "text/javascript1.3", "text/javascript1.4",
  "text/javascript1.5", "text/jscript", "text/livescript", "text/x-ecmascript", "text/x-javascript",
]);

/** Every `<script>` element in `html`, in document order. */
export function htmlScriptBlocks(html: string): HtmlScriptBlock[] {
  const blocks: HtmlScriptBlock[] = [];
  for (const match of html.matchAll(SCRIPT_BLOCK)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[1]!.matchAll(ATTRIBUTE)) {
      const name = attribute[1]!.toLowerCase();
      if (!attributes.has(name)) attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    blocks.push({ attributes, body: match[2]! });
  }
  return blocks;
}

/** Whether a script `type` attribute makes the browser run the element (absent counts as empty). */
export function isRunnableScriptType(type: string | undefined): boolean {
  return SCRIPT_TYPES.has((type ?? "").trim().toLowerCase());
}

/** A script the browser runs from its own body: no `src`, a runnable type. */
export function isRunnableInlineScript(block: HtmlScriptBlock): boolean {
  return !block.attributes.has("src") && isRunnableScriptType(block.attributes.get("type"));
}

/**
 * The CSP source that allows one inline script or style body: `'sha256-…'`
 * over its UTF-8 text, line endings as the HTML parser leaves them.
 */
export async function cspHashSource(text: string): Promise<string> {
  const normalized = text.replace(/\r\n?/g, "\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `'sha256-${btoa(binary)}'`;
}

/** The hash sources of every inline script in `html` that the browser would run. */
export async function inlineScriptHashSources(html: string): Promise<string[]> {
  const bodies = htmlScriptBlocks(html).filter(isRunnableInlineScript).map((block) => block.body);
  return [...new Set(await Promise.all(bodies.map(cspHashSource)))];
}

/** One policy from its directives, each source once, empty directives dropped. */
export function serializeCsp(directives: ReadonlyArray<readonly [string, readonly string[]]>): string {
  return directives
    .map(([name, sources]) => [name, ...new Set(sources.filter(Boolean))].join(" "))
    .join("; ");
}

/** The origin of an absolute http(s) URL, or null. */
function httpOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The WebSocket origin of the document's own origin (the realtime hub lives below it). */
function socketOrigin(origin: string): string {
  return origin.replace(/^http/, "ws");
}

export interface DashboardCspOptions {
  /** The dashboard document's origin: its API, auth, uploads and realtime socket all live below it. */
  documentOrigin: string;
  /** The storefront the theme editor and the section library frame (the Platform storefront URL). */
  storefrontUrl?: string | null;
  /** Where the store's media is served (the Platform media URL): the library's photos and videos. */
  mediaUrl?: string | null;
  /** `vite dev` only: its update socket. */
  developmentSocketOrigins?: readonly string[];
}

/**
 * The dashboard document's policy. Scripts: its own bundles and the shell's
 * hashed inline scripts, never `'unsafe-inline'` or `'unsafe-eval'`. Styles
 * keep `'unsafe-inline'`: the UI library sets styles at runtime (Radix's
 * scroll lock and popper positioning, Sonner's sheet, the editor's
 * resizable images), which no hash can name. Images may come from any https
 * host (rich text pasted with images from elsewhere, the email preview); none
 * of it runs. Video and audio come only from the store's media origin. Frames: the storefront's theme preview and the
 * video hosts the editor embeds. Nothing frames the dashboard.
 */
export async function dashboardDocumentCsp(shellHtml: string, options: DashboardCspOptions): Promise<string> {
  const storefront = httpOrigin(options.storefrontUrl);
  const media = httpOrigin(options.mediaUrl);
  const socket = socketOrigin(options.documentOrigin);
  // The shell's own inline scripts, hashed from the exact bytes served, and the
  // printable documents the dashboard opens.
  const scriptHashes = [...await inlineScriptHashSources(shellHtml), await cspHashSource(PRINT_ON_LOAD_SCRIPT)];
  return serializeCsp([
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...scriptHashes]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:", ...(media ? [media] : [])]],
    ["font-src", ["'self'", "data:"]],
    ["media-src", ["'self'", "blob:", ...(media ? [media] : [])]],
    ["connect-src", ["'self'", socket, ...(options.developmentSocketOrigins ?? [])]],
    ["frame-src", ["'self'", ...(storefront ? [storefront] : []), ...VIDEO_EMBED_FRAME_SOURCES]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ]);
}
