// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { shouldExitRichTextFullscreen } from "./tiptap-fullscreen";

describe("rich-text fullscreen keyboard handling", () => {
  it("exits only when Escape originates inside the editor", () => {
    const editorRoot = document.createElement("div");
    const editorButton = document.createElement("button");
    const popoverInput = document.createElement("input");
    editorRoot.append(editorButton);
    document.body.append(editorRoot, popoverInput);

    expect(
      shouldExitRichTextFullscreen(
        { key: "Escape", target: editorButton },
        editorRoot,
      ),
    ).toBe(true);
    expect(
      shouldExitRichTextFullscreen(
        { key: "Escape", target: popoverInput },
        editorRoot,
      ),
    ).toBe(false);
    expect(
      shouldExitRichTextFullscreen(
        { key: "Enter", target: editorButton },
        editorRoot,
      ),
    ).toBe(false);
  });
});
