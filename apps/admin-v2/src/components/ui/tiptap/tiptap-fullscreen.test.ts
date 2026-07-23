// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  isolateRichTextFullscreenBackground,
  shouldExitRichTextFullscreen,
} from "./tiptap-fullscreen";

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

  it("isolates the background while leaving the editor branch interactive", () => {
    const app = document.createElement("div");
    const sidebar = document.createElement("aside");
    const page = document.createElement("main");
    const editorCard = document.createElement("section");
    const editorRoot = document.createElement("div");
    const cardActions = document.createElement("button");
    const bodyPortal = document.createElement("div");
    editorCard.append(editorRoot, cardActions);
    page.append(editorCard);
    app.append(sidebar, page);
    document.body.append(app, bodyPortal);

    const restore = isolateRichTextFullscreenBackground(editorRoot);

    expect(editorRoot.inert).toBe(false);
    expect(editorCard.inert).toBe(false);
    for (const backgroundElement of [cardActions, sidebar, bodyPortal]) {
      expect(backgroundElement.inert).toBe(true);
      expect(backgroundElement.getAttribute("aria-hidden")).toBe("true");
    }

    const fullscreenPopover = document.createElement("div");
    document.body.append(fullscreenPopover);
    expect(fullscreenPopover.inert).toBe(false);

    restore();
    for (const backgroundElement of [cardActions, sidebar, bodyPortal]) {
      expect(backgroundElement.inert).toBe(false);
      expect(backgroundElement.hasAttribute("aria-hidden")).toBe(false);
    }
  });

  it("restores pre-existing inert and aria-hidden state exactly", () => {
    const editorRoot = document.createElement("div");
    const hiddenSibling = document.createElement("div");
    hiddenSibling.inert = true;
    hiddenSibling.setAttribute("aria-hidden", "false");
    const parent = document.createElement("div");
    parent.append(editorRoot, hiddenSibling);
    document.body.append(parent);

    const restore = isolateRichTextFullscreenBackground(editorRoot);
    restore();

    expect(hiddenSibling.inert).toBe(true);
    expect(hiddenSibling.getAttribute("aria-hidden")).toBe("false");
  });
});
