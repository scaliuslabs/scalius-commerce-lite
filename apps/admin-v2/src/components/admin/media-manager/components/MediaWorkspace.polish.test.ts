import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const filters = readFileSync(new URL("./MediaFilterBar.tsx", import.meta.url), "utf8");
const folders = readFileSync(new URL("./FolderBrowser.tsx", import.meta.url), "utf8");
const preview = readFileSync(new URL("./MediaPreview.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("./MediaCard.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../MediaWorkspace.tsx", import.meta.url), "utf8");
const gallery = readFileSync(new URL("./MediaGallery.tsx", import.meta.url), "utf8");
const uploadQueue = readFileSync(new URL("./MediaUploadQueue.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../../../ui/dialog.tsx", import.meta.url), "utf8");
const videoPlayer = readFileSync(new URL("../../../ui/video-player.tsx", import.meta.url), "utf8");
const globalStyles = readFileSync(new URL("../../../../styles/global.css", import.meta.url), "utf8");

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
    expect(folders).toContain('className="hidden min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 md:block"');
    expect(folders).toContain('aria-current={currentFolderId === id ? "page" : undefined}');
  });

  it("keeps top-level media controls touch-sized on mobile and dense on desktop", () => {
    expect(workspace.match(/h-11 px-2\.5 text-xs sm:h-7/g)).toHaveLength(2);
    expect(workspace).toContain('className="h-11 sm:h-8"');
    expect(filters).toContain('className="h-11 sm:h-8"');
    expect(folders).toContain('compact ? "h-11 max-w-40 border bg-background"');
    expect(card).toContain('className="h-11 w-11 bg-background/90 sm:h-7 sm:w-7"');
    expect(uploadQueue).toContain('className="h-11 w-11 sm:h-7 sm:w-7"');
    expect(uploadQueue).toContain('className="h-11 text-xs sm:h-7"');
  });

  it("keeps media copy user-facing and recovery-oriented", () => {
    expect(workspace).toContain("Assets in use cannot be deleted.");
    expect(workspace).not.toContain("R2 object");
    expect(uploadQueue).toContain("Keep this tab open");
    expect(uploadQueue).not.toContain("5 MiB parts");
    expect(gallery).toContain("Try another search, folder, or file type.");
    expect(preview).toContain("No poster selected");
    expect(preview).toContain("Unsaved name, description, and poster changes will be lost.");
  });

  it("keeps library-management commands out of picker workspaces", () => {
    expect(workspace.match(/allowManagement=\{!picker\}/g)).toHaveLength(2);
  });

  it("shows only limits relevant to the active picker capability", () => {
    expect(workspace).toContain('if (capability === "image") return "Images up to 20 MiB"');
    expect(workspace).toContain('if (capability === "video") return "MP4 or WebM up to 100 MiB"');
    expect(workspace).toContain("mediaLimitHint(capability, picker)");
    expect(workspace).toContain('<p className="sr-only">{limitHint}</p>');
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

  it("uses one lazy accessible player theme with native controls as fallback", () => {
    expect(preview).toContain("<VideoPlayer");
    expect(videoPlayer).toContain('import("@player.style/minimal")');
    expect(videoPlayer).toContain('customElements.whenDefined(VIDEO_THEME_TAG)');
    expect(videoPlayer).toContain("controls={!enhanced}");
    expect(videoPlayer).toContain('slot="media"');
    expect(videoPlayer).toContain("video?.pause()");
    expect(globalStyles).toContain("media-theme-minimal::part(button)");
    expect(globalStyles).toContain("min-width: 44px");
    expect(preview).toContain('"Video description"');
    expect(preview).not.toContain("not a timed caption track");
  });
});
