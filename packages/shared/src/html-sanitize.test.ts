import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./html-sanitize";

describe("sanitizeHtml", () => {
  it("adds intrinsic dimensions from Cloudflare image transforms", () => {
    const html = sanitizeHtml(
      '<img src="https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=600,height=450,quality=85/example.png" alt="Shoe">',
    );

    expect(html).toContain('src="https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=600,height=450,quality=85/example.png"');
    expect(html).toContain('width="600"');
    expect(html).toContain('height="450"');
  });

  it("keeps merchant-provided image dimensions", () => {
    const html = sanitizeHtml(
      '<img src="https://cloud.scalius.com/cdn-cgi/image/width=600,height=450/example.png" width="320" height="240" alt="Shoe">',
    );

    expect(html).toContain('width="320"');
    expect(html).toContain('height="240"');
  });

  it("does not invent dimensions for generic or incomplete image URLs", () => {
    const generic = sanitizeHtml('<img src="https://example.com/image.png" alt="Plain">');
    const incomplete = sanitizeHtml(
      '<img src="https://cloud.scalius.com/cdn-cgi/image/width=600,quality=85/example.png" alt="No height">',
    );

    expect(generic).not.toContain('width="');
    expect(generic).not.toContain('height="');
    expect(incomplete).not.toContain('width="600"');
    expect(incomplete).not.toContain('height="');
  });
});
