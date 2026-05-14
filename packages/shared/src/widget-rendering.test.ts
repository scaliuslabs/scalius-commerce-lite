import { describe, expect, it } from "vitest";
import {
  evaluateWidgetRenderability,
  hasLikelyTruncatedCss,
  normalizeWidgetParts,
  prepareScopedWidgetContent,
  stripWidgetRuntimeMarkup,
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

  it("removes model-authored runtime widget wrappers before rendering", () => {
    const parts = normalizeWidgetParts({
      htmlContent: `
        <div class="widget-container cms-widget-frame" data-widget-id="fake" data-scalius-widget-root="true">
          <section class="campaign">
            <h2>Energy picks</h2>
          </section>
        </div>
      `,
      cssContent: ".widget-container { margin: 0; } .campaign { padding: 24px; }",
    });

    expect(parts.html).toContain('<section class="campaign">');
    expect(parts.html).not.toContain("widget-container");
    expect(parts.html).not.toContain("cms-widget-frame");
    expect(parts.html).not.toContain("data-scalius-widget-root");
    expect(parts.html).not.toContain("data-widget-id");
  });

  it("keeps non-runtime classes when stripping reserved widget classes", () => {
    const html = stripWidgetRuntimeMarkup(`
      <section class="widget-container campaign-shell" data-widget-id="model-owned">
        <div class="widget-placement-zone content-band">Copy</div>
      </section>
    `);

    expect(html).toContain('class="campaign-shell"');
    expect(html).toContain('class="content-band"');
    expect(html).not.toContain("widget-container");
    expect(html).not.toContain("widget-placement-zone");
    expect(html).not.toContain("data-widget-id");
  });

  it("reports CSS that cannot survive sanitization and scoping", () => {
    const report = evaluateWidgetRenderability({
      id: "wid_bad_css",
      htmlContent: '<section class="hero">Hero</section>',
      cssContent: ".hero[ { color: red; }",
    });

    expect(report.hasInputCss).toBe(true);
    expect(report.hasRenderableCss).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/removed|discarded/i);
  });

  it("reports HTML that cannot survive sanitization", () => {
    const report = evaluateWidgetRenderability({
      id: "wid_bad_html",
      htmlContent: "<script>alert(1)</script>",
      cssContent: ".hero { color: red; }",
    });

    expect(report.hasInputHtml).toBe(true);
    expect(report.hasRenderableHtml).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/html was removed/i);
  });

  it("detects dangling declarations and unbalanced generated CSS", () => {
    expect(hasLikelyTruncatedCss(".badge { top:")).toBe(true);
    expect(hasLikelyTruncatedCss(".badge { top: 12px;")).toBe(true);
    expect(hasLikelyTruncatedCss(".button { display:flex; text-decoration")).toBe(true);
    expect(hasLikelyTruncatedCss(".badge { top: 12px; }")).toBe(false);
  });
});
