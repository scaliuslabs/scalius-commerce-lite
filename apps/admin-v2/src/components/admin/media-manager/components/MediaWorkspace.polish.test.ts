import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const filters = readFileSync(new URL("./MediaFilterBar.tsx", import.meta.url), "utf8");
const folders = readFileSync(new URL("./FolderBrowser.tsx", import.meta.url), "utf8");
const preview = readFileSync(new URL("./MediaPreview.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("./MediaCard.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../MediaWorkspace.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../../../ui/dialog.tsx", import.meta.url), "utf8");

describe("media workspace polish boundaries", () => {
  it("keeps bulk commands explicit and touch-sized on compact screens", () => {
    expect(filters).toContain("Select all shown");
    expect(filters).toContain("Move to trash");
    expect(filters).toContain("Delete permanently");
    expect(filters).toContain('aria-label="Destination folder"');
    expect(filters).toContain('className="h-11 px-2 text-xs sm:h-7"');
  });

  it("uses a single-row folder rail on mobile and a stable sidebar on desktop", () => {
    expect(folders).toContain('className="flex w-full gap-1 overflow-x-auto p-2 md:hidden"');
    expect(folders).toContain('className="hidden flex-1 md:block"');
    expect(folders).toContain('aria-current={currentFolderId === id ? "page" : undefined}');
  });

  it("keeps top-level media controls touch-sized on mobile and dense on desktop", () => {
    expect(workspace.match(/h-11 px-2\.5 text-xs sm:h-7/g)).toHaveLength(2);
    expect(workspace).toContain('className="h-11 sm:h-8"');
    expect(filters).toContain('className="h-11 sm:h-8"');
    expect(folders).toContain('compact ? "h-11 max-w-40 border bg-background"');
    expect(card).toContain('className="h-11 w-11 bg-background/90 sm:h-7 sm:w-7"');
  });

  it("keeps library-management commands out of picker workspaces", () => {
    expect(workspace.match(/allowManagement=\{!picker\}/g)).toHaveLength(2);
  });

  it("protects unsaved preview metadata before close or navigation", () => {
    expect(preview).toContain('setPendingAction("close")');
    expect(preview).toContain("setPendingAction(direction)");
    expect(preview).toContain("Discard unsaved details?");
    expect(preview).toContain('dirty ? "Unsaved details"');
    expect(preview).toContain("!dirty || saving");
    expect(preview).toContain("draftKeyRef.current === draftKey");
  });

  it("keeps preview and shared dialog actions touch-sized on mobile", () => {
    expect(preview).toContain('className="h-11 text-[13px] sm:h-8"');
    expect(preview.match(/className="h-11 flex-1 sm:h-8"/g)).toHaveLength(2);
    expect(preview).toContain('className="h-11 sm:h-8" disabled');
    expect(preview).toContain("h-11 w-11 -translate-y-1/2 sm:h-8 sm:w-8");
    expect(dialog).toContain("h-11 w-11 items-center justify-center");
    expect(dialog).toContain("sm:h-8 sm:w-8");
  });

  it("removes per-item lifecycle controls while bulk selection is active", () => {
    expect(card).toContain("{!selectionMode && <div");
    expect(card).toContain('role="listitem"');
  });
});
