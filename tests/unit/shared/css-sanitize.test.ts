import { describe, expect, it } from "vitest";
import { sanitizeCssForStyleElement } from "../../../packages/shared/src/css-sanitize";
import { scopeCss } from "../../../packages/shared/src/css-scope";

describe("sanitizeCssForStyleElement", () => {
  it("prevents style-element breakout and script tag injection", () => {
    const sanitized = sanitizeCssForStyleElement(
      `.hero{color:red}</style><script>alert(1)</script><style>.next{color:blue}`,
    );

    expect(sanitized).toContain(".hero{color:red}");
    expect(sanitized).toContain(".next{color:blue}");
    expect(sanitized).not.toMatch(/<\/?style/i);
    expect(sanitized).not.toMatch(/<\/?script/i);
    expect(sanitized).not.toContain("<");
    expect(sanitized).not.toContain(">");
  });

  it("removes unsafe stylesheet at-rules while preserving responsive rules", () => {
    const sanitized = sanitizeCssForStyleElement(`
      @charset "utf-8";
      @import url("https://example.com/evil.css");
      @\\69 mport url("https://example.com/escaped.css");
      @namespace svg url("http://www.w3.org/2000/svg");
      @property --brand-color { syntax: "<color>"; inherits: true; initial-value: red; }
      @starting-style { .hero { opacity: 0; } }
      @font-face { font-family: Evil; src: url("https://example.com/evil.woff2"); }
      @\\66 ont-face { font-family: EvilEscaped; src: url("https://example.com/evil.woff2"); }
      @media (min-width: 768px) { .hero { display: grid; } }
    `);

    expect(sanitized).not.toMatch(/@charset|@import|@namespace|@font-face/i);
    expect(sanitized).not.toMatch(/@\\69 mport|@\\66 ont-face|@property|@starting-style/i);
    expect(sanitized).toContain("@media");
    expect(sanitized).toContain(".hero{display:grid}");
  });

  it("neutralizes script-capable CSS values including escaped protocols", () => {
    const sanitized = sanitizeCssForStyleElement(`
      .hero {
        width: expression(alert(1));
        behavior: url(evil.htc);
        background: url(javascript:alert(1));
        background-image: url ( https://cloud.scalius.com/safe-image.jpg );
        border-image: url("\\6a avascript:alert(1)");
        mask: url(data:image/svg+xml,<svg onload=alert(1)>);
      }
    `);

    expect(sanitized).not.toMatch(/expression\s*\(/i);
    expect(sanitized).not.toMatch(/behavior\s*:/i);
    expect(sanitized).not.toMatch(/javascript:/i);
    expect(sanitized).not.toMatch(/data:image/i);
    expect(sanitized.match(/url\(about:blank\)/g)).toHaveLength(3);
    expect(sanitized).toContain("url ( https://cloud.scalius.com/safe-image.jpg )");
  });

  it("keeps widget selectors scoped away from global page targets", () => {
    const scoped = scopeCss(
      sanitizeCssForStyleElement(`
        body, html, :root { position: fixed; inset: 0; }
        .card { color: red; }
      `),
      "sw-safe",
    );

    expect(scoped).not.toMatch(/\bbody\b|\bhtml\b|:root/);
    expect(scoped).toContain(".sw-safe");
    expect(scoped).toContain(".sw-safe .card");
  });

  it("scopes root-conditioned selectors without targeting the global page", () => {
    const scoped = scopeCss(
      sanitizeCssForStyleElement(`
        body.dark .card,
        :root[data-theme="sale"] .badge { color: red; }
      `),
      "sw-safe",
    );

    expect(scoped).toContain("body.dark .sw-safe .card");
    expect(scoped).toContain(':root[data-theme="sale"] .sw-safe .badge');
    expect(scoped).not.toContain(".sw-safe body.dark");
  });

  it("namespaces widget keyframes and rewrites animation declarations", () => {
    const scoped = scopeCss(
      sanitizeCssForStyleElement(`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @-webkit-keyframes slide-up { to { transform: translateY(0); } }
        .hero {
          animation: fadeIn 0.4s ease-out, slide-up 0.6s ease;
          animation-name: fadeIn;
        }
      `),
      "sw-safe",
    );

    expect(scoped).toContain("@keyframes sw-safe-fadein");
    expect(scoped).toContain("@-webkit-keyframes sw-safe-slide-up");
    expect(scoped).toContain("animation:sw-safe-fadein 0.4s ease-out,sw-safe-slide-up 0.6s ease");
    expect(scoped).toContain("animation-name:sw-safe-fadein");
    expect(scoped).not.toContain("@keyframes fadeIn");
  });

  it("drops unsupported block at-rules during scoping", () => {
    const scoped = scopeCss(
      sanitizeCssForStyleElement(`
        @scope (.page) { .card { color: red; } }
        @page { margin: 0; }
        @supports (display: grid) { .grid { display: grid; } }
      `),
      "sw-safe",
    );

    expect(scoped).not.toMatch(/@scope|@page/);
    expect(scoped).toContain("@supports");
    expect(scoped).toContain(".sw-safe .grid");
  });
});
