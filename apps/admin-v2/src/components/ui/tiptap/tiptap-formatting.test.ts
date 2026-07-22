// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTiptapExtensions } from "./tiptap-extensions";
import {
  canToggleRichTextBlockquote,
  canToggleRichTextList,
  toggleRichTextBlockquote,
  toggleRichTextBulletList,
  toggleRichTextOrderedList,
} from "./tiptap-formatting";

describe("rich-text block formatting", () => {
  let editor: Editor | null = null;

  const createEditor = (content: string) => {
    editor = new Editor({
      extensions: createTiptapExtensions("Write something"),
      content,
    });
    return editor;
  };

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("converts the active bullet-list item into a blockquote", () => {
    const instance = createEditor(
      '<ul class="list-disc pl-5"><li><p>Quoted item</p></li></ul>',
    );
    instance.commands.focus("start");

    expect(canToggleRichTextBlockquote(instance)).toBe(true);
    expect(toggleRichTextBlockquote(instance)).toBe(true);
    expect(instance.getHTML()).toContain(
      "<blockquote><p>Quoted item</p></blockquote>",
    );
    expect(instance.getHTML()).not.toContain("<ul");
  });

  it("converts the active numbered-list item into a blockquote", () => {
    const instance = createEditor(
      '<ol class="list-decimal pl-5"><li><p>Quoted item</p></li></ol>',
    );
    instance.commands.focus("start");

    expect(toggleRichTextBlockquote(instance)).toBe(true);
    expect(instance.getHTML()).toContain(
      "<blockquote><p>Quoted item</p></blockquote>",
    );
    expect(instance.getHTML()).not.toContain("<ol");
  });

  it("switches cleanly between bullet and numbered lists", () => {
    const instance = createEditor("<p>List item</p>");
    instance.commands.focus("start");

    expect(toggleRichTextBulletList(instance)).toBe(true);
    expect(instance.getHTML()).toContain("<ul");
    expect(toggleRichTextOrderedList(instance)).toBe(true);
    expect(instance.getHTML()).toContain("<ol");
    expect(instance.getHTML()).not.toContain("<ul");
  });

  it("disables text-block formatting for selected media atoms", () => {
    const instance = createEditor(
      '<img src="https://cloud.scalius.com/media/example.webp" alt="Example">',
    );
    let imagePosition = -1;
    instance.state.doc.descendants((node, position) => {
      if (node.type.name === "image") imagePosition = position;
    });
    expect(imagePosition).toBeGreaterThanOrEqual(0);
    instance.commands.setNodeSelection(imagePosition);

    expect(canToggleRichTextList(instance)).toBe(false);
    expect(canToggleRichTextBlockquote(instance)).toBe(false);
    expect(toggleRichTextBulletList(instance)).toBe(false);
    expect(toggleRichTextBlockquote(instance)).toBe(false);
  });
});
