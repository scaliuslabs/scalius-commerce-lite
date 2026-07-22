import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validatePromotionListSearch } from "./index";

const editorSource = readFileSync(
  fileURLToPath(new URL("../../../components/admin/promotion/PromotionBuilder.tsx", import.meta.url)),
  "utf8",
);
const modelSource = readFileSync(
  fileURLToPath(new URL("../../../components/admin/promotion/promotion-editor-model.ts", import.meta.url)),
  "utf8",
);
const listRouteSource = readFileSync(
  fileURLToPath(new URL("./index.tsx", import.meta.url)),
  "utf8",
);
const listSource = readFileSync(
  fileURLToPath(
    new URL(
      "../../../components/admin/promotion/PromotionList.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("promotion workspace routes", () => {
  it("keeps bounded list search and status in canonical URL state", () => {
    expect(validatePromotionListSearch({ q: "  summer  ", status: "active" })).toEqual({
      q: "summer",
      status: "active",
    });
    expect(validatePromotionListSearch({ q: " ", status: "scheduled" })).toEqual({});
  });

  it("does not advertise evaluator capabilities that checkout does not own", () => {
    expect(modelSource).toContain('method: "code"');
    expect(editorSource).not.toContain("automatic promotion");
    expect(editorSource).not.toContain("Buy X");
    expect(editorSource).not.toContain("stacking");
  });

  it("preserves unsaved edits behind explicit revision-conflict recovery", () => {
    expect(editorSource).toContain("Your changes are still here");
    expect(editorSource).toContain("reloadLatest");
    expect(editorSource).toContain("UnsavedChangesGuard");
  });

  it("does not advertise write or lifecycle actions without matching permissions", () => {
    expect(listRouteSource).toContain("DISCOUNTS_CREATE");
    expect(editorSource).toContain("DISCOUNTS_EDIT");
    expect(editorSource).toContain("DISCOUNTS_TOGGLE_STATUS");
    expect(editorSource).toContain("DISCOUNTS_DELETE");
  });

  it("keeps the promotion list concise and touch-sized on mobile", () => {
    expect(listRouteSource).not.toContain("revision safety");
    expect(listRouteSource).toContain("h-11 w-full sm:h-9 sm:w-auto");
    expect(listSource).toContain('placeholder="Search promotions…"');
    expect(listSource).toContain('className="h-11 pl-9 sm:h-9"');
    expect(listSource).toContain('className="h-11 w-full sm:h-9 sm:w-40"');
  });
});
