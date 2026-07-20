import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const containerSource = readFileSync(
  resolve(import.meta.dirname, "DeliveryLocationsContainer.tsx"),
  "utf8",
);
const tableSource = readFileSync(
  resolve(import.meta.dirname, "LocationsTable.tsx"),
  "utf8",
);

describe("delivery location responsive workspace", () => {
  it("stacks the mobile toolbar and keeps every merchant action reachable", () => {
    expect(containerSource).toContain(
      "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
    );
    expect(containerSource).toContain("grid w-full grid-cols-2 gap-2");
    expect(containerSource).toContain("Search ${labels.plural}...");
    expect(containerSource).not.toContain("Search ${state.activeTab}s...");
  });

  it("keeps compact mobile rows operable and labels icon-only controls", () => {
    expect(tableSource).toContain('className="hidden sm:table-cell"');
    expect(tableSource).toContain('aria-label={`Edit ${location.name}`}');
    expect(tableSource).toContain('aria-label={`Delete ${location.name}`}');
    expect(tableSource).toContain('aria-label={`${location.isActive ? "Deactivate" : "Activate"} ${location.name}`}');
    expect(tableSource).toContain("flex flex-col gap-3 px-3 py-3 sm:flex-row");
    expect(tableSource).not.toContain("{type}s");
  });
});
