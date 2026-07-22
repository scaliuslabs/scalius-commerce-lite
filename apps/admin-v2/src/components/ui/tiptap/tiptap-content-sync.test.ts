import { describe, expect, it } from "vitest";
import { reconcileExternalTiptapContent } from "./tiptap-content-sync";

describe("reconcileExternalTiptapContent", () => {
  it("does not roll back a local transaction while its controlled prop is stale", () => {
    expect(
      reconcileExternalTiptapContent({
        incomingContent: "<p>Before</p>",
        lastExternalContent: "<p>Before</p>",
        editorContent: "<p>Before</p><p>After Enter</p>",
        pendingLocalContents: ["<p>Before</p><p>After Enter</p>"],
      }),
    ).toEqual({
      shouldApply: false,
      pendingLocalContents: ["<p>Before</p><p>After Enter</p>"],
    });
  });

  it("does not replace the document when the parent acknowledges a local update", () => {
    expect(
      reconcileExternalTiptapContent({
        incomingContent: "<ul><li><p>Item</p></li></ul>",
        lastExternalContent: "<p>Item</p>",
        editorContent: "<ul><li><p>Item</p></li></ul>",
        pendingLocalContents: ["<ul><li><p>Item</p></li></ul>"],
      }),
    ).toEqual({ shouldApply: false, pendingLocalContents: [] });
  });

  it("ignores an older acknowledgement when a newer local edit already exists", () => {
    expect(
      reconcileExternalTiptapContent({
        incomingContent: "<p>First edit</p>",
        lastExternalContent: "<p>Before</p>",
        editorContent: "<p>Second edit</p>",
        pendingLocalContents: ["<p>First edit</p>", "<p>Second edit</p>"],
      }),
    ).toEqual({
      shouldApply: false,
      pendingLocalContents: ["<p>Second edit</p>"],
    });
  });

  it("applies a real external reset", () => {
    expect(
      reconcileExternalTiptapContent({
        incomingContent: "<blockquote><p>Reset</p></blockquote>",
        lastExternalContent: "<p>Before</p>",
        editorContent: "<p>Local draft</p>",
        pendingLocalContents: ["<p>Local draft</p>"],
      }),
    ).toEqual({ shouldApply: true, pendingLocalContents: [] });
  });
});
