import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DiscountCodeBuilder } from "./DiscountCodeBuilder";

const builder = readFileSync(
  fileURLToPath(new URL("./DiscountCodeBuilder.tsx", import.meta.url)),
  "utf8",
);
const createRoute = readFileSync(
  fileURLToPath(new URL("../../../routes/admin/discounts/new.tsx", import.meta.url)),
  "utf8",
);
const editRoute = readFileSync(
  fileURLToPath(
    new URL("../../../routes/admin/discounts/$discountId/edit.tsx", import.meta.url),
  ),
  "utf8",
);
const productSelector = readFileSync(
  fileURLToPath(new URL("./ProductSelector.tsx", import.meta.url)),
  "utf8",
);
const collectionSelector = readFileSync(
  fileURLToPath(new URL("./CollectionSelector.tsx", import.meta.url)),
  "utf8",
);

function openingButtonTags(source: string): string[] {
  return source.match(/<Button\b[\s\S]*?>/g) ?? [];
}

describe("unified discount builder workflow", () => {
  it("loads as the single executable builder component", () => {
    expect(typeof DiscountCodeBuilder).toBe("function");
  });

  it("uses one builder for every supported code outcome", () => {
    expect(builder).toContain("Code and value");
    expect(builder).toContain("Purchase requirements");
    expect(builder).toContain("Schedule and usage");
    expect(builder).toContain("Combines with");
    expect(builder).toContain("No other codes");
    expect(builder).not.toContain("combineWithProductDiscounts");
  });

  it("owns the selected outcome in validated route search state", () => {
    expect(createRoute).toContain("validateDiscountCreateSearch");
    expect(createRoute).toContain("Route.useSearch().type");
    expect(createRoute).toContain("discountEditorTypes.includes");
    expect(createRoute).toContain("search: (previous) => ({ ...previous, type })");
    expect(createRoute).not.toContain("useState<DiscountEditorType");
  });

  it("preserves dirty input, save failure, keyboard semantics, and mobile actions", () => {
    expect(builder).toContain("UnsavedChangesGuard");
    expect(builder).toContain("form.formState.isDirty");
    expect(builder).toContain("Discount not saved");
    expect(builder).toContain('type="submit"');
    expect(builder).toContain('type="button"');
    expect(builder).toContain("safe-area-inset-bottom");
    expect(builder).toContain("bg-card");
    expect(builder).not.toContain("bg-white");
    expect(builder).toContain("Saved rule needs repair");
    expect(builder).toContain("hasPendingChanges");
    expect(builder).toContain("needsDiscountWriteNormalization");
  });

  it("keeps activation copy distinct from the lifecycle status", () => {
    expect(builder).toContain('discountId ? "Discount active" : "Activate after saving"');
    expect(builder).not.toContain('field.value ? "Enabled" : "Draft"');
    expect(builder).toContain('<Badge variant="outline">{lifecycleLabel(values)}</Badge>');
  });

  it("claims the loaded revision and preserves input when a newer rule wins", () => {
    expect(builder).toContain("discountRevision");
    expect(builder).toContain("expectedRevision: discountRevision");
    expect(builder).toContain("readDiscountRevisionConflict");
    expect(builder).toContain("Another session changed this rule");
    expect(builder).toContain("Reload latest");
    expect(editRoute).toContain("discountRevision={duplicate ? undefined : discount.revision}");
  });

  it("keeps edit read failures local instead of redirecting them as missing records", () => {
    expect(editRoute).toContain("RouteErrorComponent");
    expect(editRoute).not.toContain(".catch(() => null)");
    expect(editRoute).not.toContain("throw redirect");
  });

  it.each([
    ["product", productSelector],
    ["collection", collectionSelector],
  ])("keeps the %s selector safe inside the discount form", (_name, selector) => {
    const buttons = openingButtonTags(selector);

    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.includes('type="button"'))).toBe(true);
    expect(selector).toContain("loadRequestRef");
    expect(selector).toContain('role="alert"');
    expect(selector).toContain("could not be loaded.");
    expect(selector).toContain("collisionPadding={16}");
  });
});
