/**
 * The presence path rule is read in place (no split/filter/regex) because the
 * presence HTML rewriter runs it for every link of a presence page. Its
 * contract is the straightforward reference below (the previous
 * implementation, kept verbatim): every helper must agree with it on a large
 * generated corpus of hrefs for every caller (`pagePath`, `serverPagePath`,
 * redirects, feeds and the rewriter).
 */
import { describe, expect, it } from "vitest";

import { isStorefrontPagePath, presenceHref, presenceOfPath, presencePath } from "./markets";

/** A copy of `NON_PAGE_SEGMENTS` in markets.ts: change both together. */
const REFERENCE_NON_PAGE_SEGMENTS = new Set([
  "api", "_astro", "_image", "~partytown", "media", "cdn-cgi", ".well-known", "ucp", "health", "theme-preview", "agent", "localization",
]);

const reference = {
  isStorefrontPagePath(pathname: string): boolean {
    if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) return false;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) return true;
    if (REFERENCE_NON_PAGE_SEGMENTS.has(segments[0]!)) return false;
    return !segments[segments.length - 1]!.includes(".");
  },
  presenceOfPath(pathname: string): string | null {
    const first = pathname.split("/")[1] ?? "";
    return /^[a-z]{2}(?:-[a-z]{2})?$/.test(first) ? first : null;
  },
  presencePath(presence: string | null | undefined, href: string): string {
    if (!presence || !href.startsWith("/") || href.startsWith("//")) return href;
    const end = href.search(/[?#]/);
    const pathname = end === -1 ? href : href.slice(0, end);
    const rest = end === -1 ? "" : href.slice(end);
    if (reference.presenceOfPath(pathname) !== null) return href;
    if (!reference.isStorefrontPagePath(pathname)) return href;
    return `/${presence}${pathname === "/" ? "" : pathname}${rest}`;
  },
  presenceHref(presence: string | null | undefined, href: string, origin: string): string {
    if (!presence) return href;
    const trimmed = href.trim();
    if (trimmed.startsWith("/")) return reference.presencePath(presence, trimmed);
    if (!/^https?:\/\//i.test(trimmed)) return href;
    try {
      const url = new URL(trimmed);
      if (url.origin !== origin) return href;
      const localized = reference.presencePath(presence, `${url.pathname}${url.search}${url.hash}`);
      return `${url.origin}${localized}`;
    } catch {
      return href;
    }
  },
};

const ORIGIN = "https://shop.example";
const PRESENCES = ["en-in", "bn", "", null, undefined] as const;

const SEGMENTS = [
  "", "en", "bn", "en-in", "hi-in", "EN-IN", "En", "e", "en-", "en-i", "en-inx", "enx", "e1", "en_in", "en-IN",
  ...REFERENCE_NON_PAGE_SEGMENTS, "API", "apis", "api.json", "mediax", "_astro2",
  "products", "linen-tote", "x.y", "robots.txt", "sitemap.xml", "feed.xml", "favicon.svg", ".", "..", ".hidden", "trailing.",
  "a b", "ü", "%2e", "a\\b", "\\", "?", "#", "a?b", "a#b", "a?b/c.d", "a#b/c.d", "-", "--", "z",
];
const HEADS = [
  "", "/", "//", "///", "\\", "/\\", "\\/", "?", "#", "?q=/x", "#/x",
  "http://shop.example", "https://shop.example", "HTTPS://SHOP.EXAMPLE", "https://shop.example:443", "https://shop.example:8443",
  "https://user@shop.example", "https://shop.example.", "https://shop.example.evil.com", "https://other.example", "https:/shop.example",
  "https:\\\\shop.example", "http:shop.example", "httpx://shop.example", "ftp://shop.example", "mailto:a@b.c", "tel:+880", "javascript:void(0)",
];
const TAILS = ["", "/", "//", "?", "#", "?a=1", "?a=b/c.d", "#x", "#x/y.z", "?a#b", "#a?b", "?/en-in/x", " ", "\t", "\n", "  "];
const LEADS = ["", " ", "  ", "\t", "\n", "\r\n", " ", "﻿", " ", "　"];

/** A deterministic PRNG, so a failure reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus(): string[] {
  const values = new Set<string>();
  // Every head with every one- and two-segment path.
  for (const head of HEADS) {
    for (const first of SEGMENTS) {
      values.add(`${head}/${first}`);
      values.add(`${head}${first}`);
      for (const second of ["", "x", "x.y", "en-in", "products", "a//b"]) values.add(`${head}/${first}/${second}`);
    }
  }
  // Random paths: often root-relative, else leading whitespace and a head; 0-4 segments joined by one or more slashes; a tail.
  const next = random(0x5ca1);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
  for (let index = 0; index < 40_000; index += 1) {
    const segments = Array.from({ length: Math.floor(next() * 5) }, () => pick(SEGMENTS));
    const joiner = () => (next() < 0.85 ? "/" : pick(["//", "///", "\\", "/./"]));
    const path = segments.map((segment) => `${joiner()}${segment}`).join("");
    const lead = next() < 0.6 ? "" : pick(LEADS);
    const head = next() < 0.5 ? "" : pick(HEADS);
    values.add(`${lead}${head}${path}${pick(TAILS)}`);
  }
  return [...values];
}

const CORPUS = corpus();

describe("presence paths match their reference on a generated corpus", () => {
  it("has a large, varied corpus", () => {
    expect(CORPUS.length).toBeGreaterThan(30_000);
    expect(CORPUS.filter((href) => reference.presencePath("en-in", href) !== href).length).toBeGreaterThan(3_000);
    expect(CORPUS.filter((href) => reference.presenceHref("en-in", href, ORIGIN) !== href && /^\s*https?:/i.test(href)).length).toBeGreaterThan(1_000);
  });

  it("isStorefrontPagePath and presenceOfPath", () => {
    for (const href of CORPUS) {
      expect(isStorefrontPagePath(href), JSON.stringify(href)).toBe(reference.isStorefrontPagePath(href));
      expect(presenceOfPath(href), JSON.stringify(href)).toBe(reference.presenceOfPath(href));
    }
  });

  it("presencePath for every presence", () => {
    for (const presence of PRESENCES) {
      for (const href of CORPUS) expect(presencePath(presence, href), `${presence} ${JSON.stringify(href)}`).toBe(reference.presencePath(presence, href));
    }
  });

  it("presenceHref for every presence and origin", () => {
    for (const presence of PRESENCES) {
      for (const origin of [ORIGIN, "http://127.0.0.1:8787"]) {
        for (const href of CORPUS) {
          expect(presenceHref(presence, href, origin), `${presence} ${origin} ${JSON.stringify(href)}`).toBe(reference.presenceHref(presence, href, origin));
        }
      }
    }
  });
});
