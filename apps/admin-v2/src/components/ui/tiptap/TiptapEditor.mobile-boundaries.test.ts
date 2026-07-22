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
const tableSource = readFileSync(
  resolve(import.meta.dirname, "TiptapTablePopover.tsx"),
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

  it("keeps the feature-rich toolbar to one scrollable row on mobile", () => {
    expect(menuSource).toContain("overflow-x-auto overscroll-x-contain scrollbar-hide");
    expect(menuSource).toContain("flex min-w-max items-center");
    expect(menuSource).not.toContain("flex flex-wrap items-center");
  });

  it("keeps image sizing usable without a precision pointer", () => {
    const imageViewSource = readFileSync(
      resolve(import.meta.dirname, "../tiptap-extensions/resizable-image-view.tsx"),
      "utf8",
    );
    expect(imageViewSource).toContain('aria-label="Image size"');
    expect(imageViewSource).toContain('<option value="25%">25%</option>');
    expect(imageViewSource).toContain('<option value="100%">Full width</option>');
    expect(imageViewSource).toContain("onPointerDown={handleResizeStart}");
    expect(imageViewSource).toContain('aria-label="Remove image"');
    expect(imageViewSource).toContain(
      'aria-label="Edit image alternative text"',
    );
    expect(imageViewSource).toContain(
      "onMouseDown={(event) => event.preventDefault()}",
    );
  });

  it("keeps table setup compact and defers editing actions until needed", () => {
    expect(tableSource).toContain('aria-label="Table rows"');
    expect(tableSource).toContain('aria-label="Table columns"');
    expect(tableSource).toContain('max="20"');
    expect(tableSource).toContain('max="10"');
    expect(tableSource).toContain("!isInTable ? (");
    expect(tableSource).not.toContain("Quick Actions:");
    expect(tableSource).not.toContain("Del Col");
    expect(tableSource).not.toContain("H Row");
  });

  it("uses one explicit fullscreen exit and names each formatting toolbar", () => {
    expect(editorSource).toContain('aria-label="Exit fullscreen"');
    expect(editorSource).toContain('ariaLabel={`${ariaLabel} formatting`}');
    expect(menuSource).not.toContain("Minimize2");
  });
});
