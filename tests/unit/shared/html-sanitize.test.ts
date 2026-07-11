import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../../../packages/shared/src/html-sanitize";

describe("parser-backed HTML sanitizer", () => {
  it("drops script-capable elements and their content", () => {
    const sanitized = sanitizeHtml(
      '<section>Safe<script>alert(1)</script><iframe src="https://evil.test"></iframe><style>body{display:none}</style></section>',
    );

    expect(sanitized).toBe("<section>Safe</section>");
  });

  it("removes encoded event handlers and unsafe URL protocols", () => {
    const sanitized = sanitizeHtml(
      '<a href="java&#x73;cript&colon;alert(1)" o&#x6e;click="steal()" target="_blank">Open</a>',
    );

    expect(sanitized).toBe(
      '<a target="_blank" rel="noopener noreferrer">Open</a>',
    );
  });

  it("preserves merchant layout attributes while removing dangerous CSS declarations", () => {
    const sanitized = sanitizeHtml(
      '<div class="hero" data-section-id="s1" aria-label="Hero" style="color:#111; background-image:url(https://cloud.scalius.com/hero.jpg); width: expression(alert(1)); behavior:url(x.htc)">Hero</div>',
    );

    expect(sanitized).toContain('class="hero"');
    expect(sanitized).toContain('data-section-id="s1"');
    expect(sanitized).toContain('aria-label="Hero"');
    expect(sanitized).toContain("color: #111");
    expect(sanitized).toContain(
      "background-image: url(https://cloud.scalius.com/hero.jpg)",
    );
    expect(sanitized).not.toContain("expression");
    expect(sanitized).not.toContain("behavior");
  });

  it("keeps safe image URLs and filters unsafe srcset candidates", () => {
    const sanitized = sanitizeHtml(
      '<img src="https://cloud.scalius.com/p.webp" srcset="javascript:alert(1) 1x, https://cloud.scalius.com/p-2x.webp 2x" alt="Product" loading="lazy" onerror="x">',
    );

    expect(sanitized).toContain('src="https://cloud.scalius.com/p.webp"');
    expect(sanitized).toContain(
      'srcset="https://cloud.scalius.com/p-2x.webp 2x"',
    );
    expect(sanitized).toContain('loading="lazy"');
    expect(sanitized).not.toContain("onerror");
    expect(sanitized).not.toContain("javascript");
  });

  it("unwraps unknown and form tags without preserving unsafe form behavior", () => {
    const sanitized = sanitizeHtml(
      '<form action="https://evil.test"><custom-card><p>Keep this copy</p></custom-card></form>',
    );

    expect(sanitized).toBe("<p>Keep this copy</p>");
  });
});
