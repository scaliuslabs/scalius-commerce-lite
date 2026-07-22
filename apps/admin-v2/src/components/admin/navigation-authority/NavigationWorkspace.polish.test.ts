import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(
  new URL("./NavigationWorkspace.tsx", import.meta.url),
  "utf8",
);

describe("navigation workspace polish boundaries", () => {
  it("keeps the resting workspace concise and sentence-cased", () => {
    expect(workspace).toContain('className="text-xl font-semibold tracking-tight">Navigation</h1>');
    expect(workspace).not.toContain("Build reusable menus, publish safely");
    expect(workspace).not.toContain("Drag to an edge or inside another item");
    expect(workspace).not.toContain("Restoring keeps history linear and auditable");
    expect(workspace).toContain("Move to trash");
    expect(workspace).toContain("Menu trash");
  });

  it("retains only state and consequence copy needed for safe actions", () => {
    expect(workspace).toContain("Clear search to arrange items");
    expect(workspace).toContain("Customers see item labels, not this name.");
    expect(workspace).toContain("Restored menus stay unpublished and unassigned.");
    expect(workspace).toContain("Items and publication history can be restored later.");
  });

  it("keeps primary navigation controls practical on mobile", () => {
    expect(workspace).toContain('className="h-11 sm:h-9" onClick={() => setTrashOpen(true)}');
    expect(workspace).toContain('className="h-11 w-full sm:h-9 sm:w-auto" onClick={() => onItemChange("new")}');
    expect(workspace).toContain('className="h-11 w-full sm:h-9 sm:w-auto"');
    expect(workspace).toContain('className="size-11 shrink-0 sm:size-9"');
    expect(workspace).toContain('className="min-h-11 sm:min-h-9"');
  });
});
