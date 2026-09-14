import { describe, expect, it } from "vitest";

import {
  DEFAULT_TAX_WORKSPACE_SECTION,
  normalizeTaxWorkspacePreview,
  normalizeTaxWorkspaceSection,
  resolveTaxWorkspaceTarget,
  TAX_WORKSPACE_ROUTE_SECTIONS,
  TAX_WORKSPACE_SECTIONS,
} from "./tax-workspace-sections";

describe("tax workspace sections", () => {
  it.each(TAX_WORKSPACE_SECTIONS)("preserves the %s section", (section) => {
    expect(normalizeTaxWorkspaceSection(section)).toBe(section);
  });

  it.each([undefined, null, "", "unknown", 1])(
    "falls back safely for %j",
    (value) => {
      expect(normalizeTaxWorkspaceSection(value)).toBe(
        DEFAULT_TAX_WORKSPACE_SECTION,
      );
    },
  );

  it.each(TAX_WORKSPACE_ROUTE_SECTIONS)(
    "maps the deep-linkable %s value onto a rendered tab",
    (value) => {
      const target = resolveTaxWorkspaceTarget(value);
      expect(TAX_WORKSPACE_SECTIONS).toContain(target.section);
    },
  );

  it("maps retired deep links onto the redesigned tabs", () => {
    expect(resolveTaxWorkspaceTarget("policy")).toEqual({
      section: "settings",
      preview: false,
    });
    expect(resolveTaxWorkspaceTarget("preview")).toEqual({
      section: "rates",
      preview: true,
    });
    expect(resolveTaxWorkspaceTarget("classification")).toEqual({
      section: "classification",
      preview: false,
    });
    expect(resolveTaxWorkspaceTarget("nope")).toEqual({
      section: DEFAULT_TAX_WORKSPACE_SECTION,
      preview: false,
    });
  });

  it("does not let a caller mutate the shared mapping", () => {
    const target = resolveTaxWorkspaceTarget("preview");
    target.section = "classes";
    target.preview = false;

    expect(resolveTaxWorkspaceTarget("preview")).toEqual({
      section: "rates",
      preview: true,
    });
  });

  it("opens the preview sheet from the retired tab and from the flag", () => {
    expect(normalizeTaxWorkspacePreview({ section: "preview" })).toBe(true);
    expect(normalizeTaxWorkspacePreview({ preview: true })).toBe(true);
    expect(normalizeTaxWorkspacePreview({ preview: "true" })).toBe(true);
    expect(normalizeTaxWorkspacePreview({ preview: "1" })).toBe(true);
    expect(normalizeTaxWorkspacePreview({ section: "rates" })).toBe(false);
    expect(normalizeTaxWorkspacePreview({ preview: "no" })).toBe(false);
    expect(normalizeTaxWorkspacePreview({})).toBe(false);
  });
});
