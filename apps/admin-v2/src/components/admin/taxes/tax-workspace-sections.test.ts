import { describe, expect, it } from "vitest";

import {
  DEFAULT_TAX_WORKSPACE_SECTION,
  normalizeTaxWorkspaceSection,
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
});
