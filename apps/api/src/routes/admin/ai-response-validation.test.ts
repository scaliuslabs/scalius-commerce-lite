import { describe, expect, it } from "vitest";
import { ValidationError } from "../../utils/api-error";
import {
  normalizeStagedPlanText,
  normalizeWidgetGenerationText,
} from "./ai-response-validation";

describe("AI response validation", () => {
  it("canonicalizes tag-based widget output", () => {
    expect(
      normalizeWidgetGenerationText(`
        Sure:
        <htmljs><section class="hero">Hello</section></htmljs>
        <css>.hero { color: red; }</css>
      `),
    ).toBe(
      `<htmljs>\n<section class="hero">Hello</section>\n</htmljs>\n\n<css>\n.hero{color:red}\n</css>`,
    );
  });

  it("sanitizes generated HTML attributes and stylesheet URLs before returning", () => {
    const output = normalizeWidgetGenerationText(`
      <htmljs><section onclick="alert(1)"><a href="javascript:alert(1)">Deal</a></section></htmljs>
      <css>.promo { background-image: url("javascript:alert(1)"); color: blue; }</css>
    `);

    expect(output).toContain("<section><a>Deal</a></section>");
    expect(output).not.toContain("onclick");
    expect(output).not.toContain("javascript:");
    expect(output).toContain("color:blue");
  });

  it("canonicalizes JSON widget output with htmljs", () => {
    expect(
      normalizeWidgetGenerationText(
        JSON.stringify({
          htmljs: '<div class="promo">Deal</div>',
          css: ".promo { display: grid; }",
        }),
      ),
    ).toContain('<div class="promo">Deal</div>');
  });

  it("rejects prose without usable widget markup", () => {
    expect(() => normalizeWidgetGenerationText("I can help you build that."))
      .toThrow(ValidationError);
  });

  it("rejects widget output without HTML tags", () => {
    expect(() => normalizeWidgetGenerationText("<htmljs>plain text</htmljs>"))
      .toThrow(ValidationError);
  });

  it("rejects script tags", () => {
    expect(() =>
      normalizeWidgetGenerationText(
        '<htmljs><div>Deal</div><script>alert("x")</script></htmljs>',
      ),
    ).toThrow(ValidationError);
  });

  it("canonicalizes valid staged plans", () => {
    const text = normalizeStagedPlanText(JSON.stringify({
      totalSections: 2,
      sectionDescriptions: ["Hero", "Featured collection"],
      estimatedTokens: 1200,
    }));

    expect(JSON.parse(text)).toEqual({
      totalSections: 2,
      sectionDescriptions: ["Hero", "Featured collection"],
      estimatedTokens: 1200,
    });
  });

  it("repairs staged plans with recoverable section mismatches", () => {
    const text = normalizeStagedPlanText(JSON.stringify({
      totalSections: 3,
      sectionDescriptions: ["Hero", "Featured collection"],
    }));

    expect(JSON.parse(text)).toEqual({
      totalSections: 3,
      sectionDescriptions: ["Hero", "Featured collection", "Section 3"],
      estimatedTokens: 2100,
    });
  });

  it("rejects staged plans without JSON", () => {
    expect(() => normalizeStagedPlanText("Create a hero and products section."))
      .toThrow(ValidationError);
  });
});
