import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const filters = readFileSync(new URL("./MediaFilterBar.tsx", import.meta.url), "utf8");
const folders = readFileSync(new URL("./FolderBrowser.tsx", import.meta.url), "utf8");
const preview = readFileSync(new URL("./MediaPreview.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("./MediaCard.tsx", import.meta.url), "utf8");

describe("media workspace polish boundaries", () => {
  it("keeps bulk commands explicit and touch-sized on compact screens", () => {
    expect(filters).toContain("Select all shown");
    expect(filters).toContain("Move to trash");
    expect(filters).toContain("Delete permanently");
    expect(filters).toContain('aria-label="Destination folder"');
    expect(filters).toContain('className="h-9 px-2 text-xs sm:h-7"');
  });

  it("uses a single-row folder rail on mobile and a stable sidebar on desktop", () => {
    expect(folders).toContain('className="flex w-full gap-1 overflow-x-auto p-2 md:hidden"');
    expect(folders).toContain('className="hidden flex-1 md:block"');
    expect(folders).toContain('aria-current={currentFolderId === id ? "page" : undefined}');
  });

  it("protects unsaved preview metadata before close or navigation", () => {
    expect(preview).toContain('setPendingAction("close")');
    expect(preview).toContain("setPendingAction(direction)");
    expect(preview).toContain("Discard unsaved details?");
    expect(preview).toContain('dirty ? "Unsaved details"');
    expect(preview).toContain("!dirty || saving");
    expect(preview).toContain("draftKeyRef.current === draftKey");
  });

  it("removes per-item lifecycle controls while bulk selection is active", () => {
    expect(card).toContain("{!selectionMode && <div");
    expect(card).toContain('role="listitem"');
  });
});
