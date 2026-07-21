import { describe, expect, it } from "vitest";
import { shouldApplyExternalTiptapContent } from "./tiptap-content-sync";

describe("shouldApplyExternalTiptapContent", () => {
  it("does not roll back a local transaction while its controlled prop is stale", () => {
    expect(
      shouldApplyExternalTiptapContent({
        incomingContent: "<p>Before</p>",
        lastExternalContent: "<p>Before</p>",
        editorContent: "<p>Before</p><p>After Enter</p>",
      }),
    ).toBe(false);
  });

  it("does not replace the document when the parent acknowledges a local update", () => {
    expect(
      shouldApplyExternalTiptapContent({
        incomingContent: "<ul><li><p>Item</p></li></ul>",
        lastExternalContent: "<p>Item</p>",
        editorContent: "<ul><li><p>Item</p></li></ul>",
      }),
    ).toBe(false);
  });

  it("applies a real external reset", () => {
    expect(
      shouldApplyExternalTiptapContent({
        incomingContent: "<blockquote><p>Reset</p></blockquote>",
        lastExternalContent: "<p>Before</p>",
        editorContent: "<p>Local draft</p>",
      }),
    ).toBe(true);
  });
});
