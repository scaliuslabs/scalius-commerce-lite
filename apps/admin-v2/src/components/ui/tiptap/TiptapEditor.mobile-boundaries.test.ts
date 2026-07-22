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
const imageViewSource = readFileSync(
  resolve(import.meta.dirname, "../tiptap-extensions/resizable-image-view.tsx"),
  "utf8",
);
const imageExtensionSource = readFileSync(
  resolve(import.meta.dirname, "../tiptap-extensions/resizable-image.tsx"),
  "utf8",
);

describe("rich text editor mobile boundaries", () => {
  it("names the editable canvas before and after the deferred editor mounts", () => {
    expect(deferredSource).toContain('ariaLabel = "Rich text content"');
    expect(deferredSource).toContain('aria-label={`Loading ${ariaLabel}`}');
    expect(deferredSource).not.toContain('role="textbox"');
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
    expect(deferredSource).toContain(
      '<div className="w-full min-w-0">',
    );
    expect(deferredSource).toContain(
      '"w-full min-w-0 overflow-hidden rounded-md border bg-background transition-colors',
    );
    expect(editorSource).toContain(
      '"flex min-w-0 w-full flex-col bg-background transition-colors"',
    );
    expect(menuSource).toContain("overflow-x-auto overscroll-x-contain scrollbar-hide");
    expect(menuSource).toContain("flex min-w-max items-center");
    expect(menuSource).not.toContain("flex flex-wrap items-center");
    expect(skeletonSource).toContain(
      "overflow-x-auto overscroll-x-contain scrollbar-hide",
    );
    expect(skeletonSource).toContain("flex min-w-max items-center");
    expect(skeletonSource).not.toContain("flex flex-wrap items-center");
  });

  it("keeps image sizing usable without a precision pointer", () => {
    expect(imageViewSource).toContain('aria-label="Image size"');
    expect(imageViewSource).toContain('<SelectItem value="25%">25%</SelectItem>');
    expect(imageViewSource).toContain(
      '<SelectItem value="100%">Full width</SelectItem>',
    );
    expect(imageViewSource).toContain(
      '<SelectItem value="custom">Custom…</SelectItem>',
    );
    expect(imageViewSource).toContain(
      'aria-label="Custom image width percentage"',
    );
    expect(imageViewSource).toContain("onPointerDown={handleResizeStart}");
    expect(imageViewSource).toContain('aria-label="Remove image"');
    expect(imageViewSource).toContain(
      'aria-label="Edit image alternative text"',
    );
    expect(imageViewSource).toContain(
      "onMouseDown={(event) => event.preventDefault()}",
    );
    expect(imageViewSource).toContain(
      '"flex h-11 w-11 items-center justify-center rounded transition-colors hover:bg-accent sm:h-8 sm:w-8"',
    );
    expect(imageViewSource).toContain('className="z-[10002]"');
    expect(imageViewSource).toContain("inline-flex w-fit max-w-full");
    expect(imageExtensionSource).toContain(
      'event.target.closest("[data-image-controls]")',
    );
  });

  it("centers fullscreen formatting tools while retaining mobile scrolling", () => {
    expect(menuSource).toContain(
      'isFullscreen ? "mx-auto w-fit max-w-full" : "flex-1"',
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
    expect(editorSource).toContain('className="min-h-11 gap-1.5 sm:min-h-9"');
    expect(editorSource).toContain('ariaLabel={`${ariaLabel} formatting`}');
    expect(menuSource).not.toContain("Minimize2");
  });

  it("keeps typing isolated from transaction-wide React rerenders", () => {
    expect(editorSource).toContain("shouldRerenderOnTransaction: false");
    expect(menuSource).toContain("useEditorState");
    expect(tableSource).toContain("useEditorState");
  });

  it("recovers the deferred editor from StrictMode replay and chunk-load failure", () => {
    expect(deferredSource).toContain("isAliveRef.current = true");
    expect(deferredSource).toContain("tiptapEditorModulePromise = null");
  });
});
