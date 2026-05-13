import { describe, expect, it } from "vitest";
import {
  normalizeWidgetParts,
  prepareScopedWidgetContent,
} from "./widget-rendering";

describe("widget rendering helpers", () => {
  it("extracts style blocks from generated HTML into the widget stylesheet", () => {
    const parts = normalizeWidgetParts({
      htmlContent: `
        <section class="hero">
          <style>.hero { color: red; }</style>
          <h2>Launch</h2>
        </section>
      `,
      cssContent: ".card { display: grid; }",
    });

    expect(parts.html).toContain('<section class="hero">');
    expect(parts.html).not.toContain("<style>");
    expect(parts.css).toContain(".card");
    expect(parts.css).toContain(".hero");
    expect(parts.extractedCss).toContain("color: red");
  });

  it("sanitizes HTML and scopes extracted CSS with the widget root class", () => {
    const prepared = prepareScopedWidgetContent({
      id: "wid_Test-123",
      htmlContent: `
        <section class="hero" onclick="alert(1)">
          <style>.hero { color: red; }</style>
          <script>alert(1)</script>
          <h2>Launch</h2>
        </section>
      `,
      cssContent: ".card { display: grid; }",
    });

    expect(prepared.scopeClass).toBe("sw-wid_test-123");
    expect(prepared.html).toContain('<section class="hero">');
    expect(prepared.html).not.toMatch(/onclick|script|style/i);
    expect(prepared.css).toContain(".sw-wid_test-123 .hero");
    expect(prepared.css).toContain(".sw-wid_test-123 .card");
  });
});
