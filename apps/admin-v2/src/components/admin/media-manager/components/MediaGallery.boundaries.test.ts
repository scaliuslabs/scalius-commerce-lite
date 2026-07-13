import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const gallery = readFileSync(new URL("./MediaGallery.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("./MediaCard.tsx", import.meta.url), "utf8");

describe("media gallery presentation boundaries", () => {
  it("uses five dense columns on wide screens and fewer columns below that", () => {
    const responsiveGrid = "grid-cols-2 gap-2.5 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

    expect(gallery.match(new RegExp(responsiveGrid, "g"))).toHaveLength(2);
    expect(gallery).not.toContain("2xl:grid-cols-6");
  });

  it("shows uncropped bounded thumbnails and keeps tile actions touch-accessible", () => {
    expect(card).toContain('width: 480, height: 360, fit: "contain", quality: 82');
    expect(card).toContain('className="h-full w-full object-contain"');
    expect(card).toContain('className="absolute right-1.5 top-1.5 flex gap-1"');
    expect(card).not.toContain("opacity-0 transition-opacity");
  });

  it("exposes truthful keyboard selection state and forwards Shift range intent", () => {
    expect(card).toContain('aria-pressed={selectionMode ? selected : undefined}');
    expect(card).toContain('aria-keyshortcuts={selectionMode ? "Shift+Enter" : undefined}');
    expect(gallery).toContain("props.onToggleSelection(file.id, event.shiftKey)");
    expect(gallery).toContain("props.onFileSelect(file, event.shiftKey)");
  });
});
