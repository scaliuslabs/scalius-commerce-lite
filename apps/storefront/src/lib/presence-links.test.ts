// @vitest-environment node
/**
 * Every link a buyer follows keeps them inside their market presence
 * (docs/MARKETS-DESIGN.md D4). Server-rendered markup is localized by the
 * gateway (lib/market-presence.ts); code that builds a page URL itself, in
 * the browser or in a script the server writes, must use `pagePath`,
 * `serverPagePath` or `logicalPathname`. This scan fails on a new
 * root-relative page URL in such code. Every exception below is reviewed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const PAGE = "(?:products|categories|brands|collections|pages|blog|search|cart|checkout|account|track-order|order-success|compare|gift-card-balance|newsletter|payment-recovery|buy|warranty-claims|navigation|apps)";
const ROOT_RELATIVE_PAGE = new RegExp(`(["'\`])/(?:${PAGE}(?:[/?#"'\`$]|$)|(?=["'\`]))`);
const WRAPPED = /\b(?:pagePath|serverPagePath|logicalPathname)\(/;

/** Reviewed lines that name a root page path without leaving the presence. */
const REVIEWED: ReadonlyArray<readonly [file: string, fragment: string, reason: string]> = [
  ["components/cards/scripts/quick-add-card.ts", 'pathname.split("/").pop()', "reads the slug, the last segment, under any presence"],
  ["components/conversation/conversation-form.ts", 'answer.data.redirect.startsWith("/")', "checks the shape; the redirect is followed through pagePath"],
  ["scripts/storefront-actions.ts", 'scope.startsWith("/categories/")', "a select value; the navigation goes through pagePath"],
  ["components/homepage/endless-grid.ts", "a[href*=\"/products/\"]", "matches a card link under any presence"],
  ["gallery/noor.ts", "link:", "dev-gallery fixture links, never served under a presence"],
  ["lib/theme-preview-library.ts", "", "reads a preview path after stripping its presence; the merchant's preview, never a buyer link"],
  ["components/order/review-form-client.ts", 'value.startsWith("/")', "validates a same-origin path"],
  ["lib/api/transport.ts", "", "API paths, not storefront pages"],
  ["lib/browser-continuation-relay.ts", "", "private relays agents open by exact root URL"],
  ["lib/theme-preview-bridge.ts", "", "the merchant's theme preview, never under a presence"],
  ["lib/account-push.ts", "const padded", "base64 alphabet, not a page path"],
  ["lib/account-push.ts", "const scope", "the service worker scope is the origin root on every presence"],
  ["lib/public-discovery-cache.ts", "", "the gateway's browser cache policy of a page's logical path"],
  ["pages/buy/[slug].ts", "Location:", "redirects: the gateway localizes Location"],
  ["pages/sitemap.xsl.ts", "", "XSL template paths"],
  ["scripts/app-forms.ts", "", "validates /apps paths after logicalPathname"],
  ["store/cart.ts", "pathname", "compares the logical path (the caller passes logicalPathname)"],
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__snapshots__" || name === "route-tests" ? [] : files(path);
    return /\.(?:ts|tsx|astro)$/.test(name) && !/\.test\./.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** The parts of a file that run in the browser or are written into a page as script. */
function clientCode(path: string, text: string): string | null {
  if (path.endsWith(".astro")) {
    return [...text.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join("\n");
  }
  if (path.endsWith(".tsx")) return text;
  if (/[/\\](?:scripts|store)[/\\]/.test(path)) return text;
  return /\b(?:window|document|location|localStorage|history)\./.test(text) ? text : null;
}

function withoutComments(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line;
}

describe("presence-preserving links in client code", () => {
  it("builds every page URL through the presence rule", () => {
    const offenders: string[] = [];
    for (const path of files(SRC)) {
      const rel = relative(SRC, path).split("\\").join("/");
      if (rel.startsWith("pages/api/") || rel === "lib/presence-url.ts" || rel === "lib/server-presence.ts") continue;
      const code = clientCode(path, readFileSync(path, "utf8"));
      if (!code) continue;
      for (const raw of code.split("\n")) {
        const line = withoutComments(raw);
        if (!ROOT_RELATIVE_PAGE.test(line) || WRAPPED.test(line) || /\bfetch\(/.test(line)) continue;
        if (REVIEWED.some(([file, fragment]) => file === rel && line.includes(fragment))) continue;
        offenders.push(`${rel}: ${line.trim().slice(0, 140)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
