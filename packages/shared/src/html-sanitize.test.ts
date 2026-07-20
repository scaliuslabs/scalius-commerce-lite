import { describe, expect, it } from "vitest";
import {
  hasRenderableHtmlContent,
  htmlToPlainText,
  sanitizeHtml,
} from "./html-sanitize";

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

describe("htmlToPlainText", () => {
  it("keeps block boundaries and decodes entities once", () => {
    expect(
      htmlToPlainText("<p>First &amp;amp; second</p><p>Third&nbsp;line.</p>"),
    ).toBe("First &amp; second Third line.");
  });

  it("drops script and style contents instead of exposing them as text", () => {
    expect(
      htmlToPlainText(
        "<p>Visible</p><script >steal()</script ><style >.bad{}</style ><p>Safe</p>",
      ),
    ).toBe("Visible Safe");
  });
});

describe("hasRenderableHtmlContent", () => {
  it("recognizes visible text and sanitized image content", () => {
    expect(hasRenderableHtmlContent("<p>&nbsp;</p>")).toBe(false);
    expect(hasRenderableHtmlContent("<p>Visible</p>")).toBe(true);
    expect(hasRenderableHtmlContent('<img src="https://example.com/item.jpg">')).toBe(true);
  });

  it("does not treat removed script content as renderable", () => {
    expect(hasRenderableHtmlContent("<script >alert(1)</script >")).toBe(false);
  });
});
