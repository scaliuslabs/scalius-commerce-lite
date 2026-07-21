import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const editorSource = readFileSync(
  resolve(import.meta.dirname, "TiptapEditor.tsx"),
  "utf8",
);
const deferredSource = readFileSync(
  resolve(import.meta.dirname, "DeferredTiptapEditor.tsx"),
  "utf8",
);
const menuSource = readFileSync(
  resolve(import.meta.dirname, "TiptapMenuBar.tsx"),
  "utf8",
);
const skeletonSource = readFileSync(
  resolve(import.meta.dirname, "TiptapToolbarSkeleton.tsx"),
  "utf8",
);

describe("rich text editor mobile boundaries", () => {
  it("names the editable canvas before and after the deferred editor mounts", () => {
    expect(deferredSource).toContain('ariaLabel = "Rich text content"');
    expect(deferredSource).toContain("aria-label={ariaLabel}");
    expect(editorSource).toContain('role: "textbox"');
    expect(editorSource).toContain('"aria-label": ariaLabel');
    expect(editorSource).toContain('"aria-multiline": "true"');
  });

  it("uses 44px mobile actions and preserves compact desktop density", () => {
    for (const source of [menuSource, skeletonSource]) {
      expect(source).toContain('"h-11 w-11 sm:h-7 sm:w-7"');
      expect(source).toContain('"h-11 w-11 sm:h-9 sm:w-9"');
    }
  });
});
