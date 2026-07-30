// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTiptapExtensions } from "./tiptap-extensions";
import {
  insertRichTextImage,
  insertRichTextTable,
  insertRichTextVideo,
} from "./tiptap-insertions";

describe("rich-text editing document contract", () => {
  let editor: Editor | null = null;

  const createEditor = (content = "<p>First</p>") => {
    editor = new Editor({
      extensions: createTiptapExtensions("Write something"),
      content,
    });
    return editor;
  };

  afterEach(() => {
    editor?.destroy();
    editor = null;
    vi.restoreAllMocks();
  });

  it("creates paragraphs and hard line breaks without losing adjacent text", () => {
    const instance = createEditor();

    expect(
      instance
        .chain()
        .focus("end")
        .splitBlock()
        .insertContent("Second")
        .setHardBreak()
        .insertContent("same paragraph")
        .run(),
    ).toBe(true);

    expect(instance.getHTML()).toBe(
      "<p>First</p><p>Second<br>same paragraph</p>",
    );
  });

  it("handles the real Enter key in paragraphs and list items", () => {
    const host = document.createElement("div");
    document.body.append(host);
    editor = new Editor({
      element: host,
      extensions: createTiptapExtensions("Write something"),
      content: "<p>First</p>",
    });

    editor.commands.focus("end");
    expect(
      host.querySelector(".ProseMirror")?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(false);
    expect(editor.chain().insertContent("Second").run()).toBe(true);
    expect(editor.getHTML()).toBe("<p>First</p><p>Second</p>");

    editor.commands.setContent("<ul><li><p>Item one</p></li></ul>");
    let itemEnd = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.textContent === "Item one") {
        itemEnd = position + node.nodeSize;
      }
    });
    expect(itemEnd).toBeGreaterThan(0);
    editor.commands.setTextSelection(itemEnd);
    editor.commands.focus();
    expect(
      host.querySelector(".ProseMirror")?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(false);
    expect(editor.chain().insertContent("Item two").run()).toBe(true);
    expect(editor.getHTML()).toContain(
      "<ul class=\"list-disc pl-5\"><li><p>Item one</p></li><li><p>Item two</p></li></ul>",
    );

    host.remove();
  });

  it("round-trips bullet lists, numbered lists, and blockquotes", () => {
    const instance = createEditor("<p>Item one</p><p>Item two</p>");
    instance.commands.selectAll();
    expect(instance.commands.toggleBulletList()).toBe(true);
    expect(instance.getHTML()).toContain("<ul");
    expect(instance.getHTML()).toContain("<li><p>Item one</p></li>");

    expect(instance.commands.toggleOrderedList()).toBe(true);
    expect(instance.getHTML()).toContain("<ol");

    instance.commands.setContent("<p>Quoted text</p>");
    expect(instance.commands.toggleBlockquote()).toBe(true);
    expect(instance.getHTML()).toContain(
      "<blockquote><p>Quoted text</p></blockquote>",
    );
  });

  it("applies text marks, links, headings, and alignment", () => {
    const instance = createEditor("<p>Formatted text</p>");
    instance.commands.selectAll();
    expect(instance.commands.toggleBold()).toBe(true);
    expect(instance.commands.toggleItalic()).toBe(true);
    expect(instance.commands.toggleUnderline()).toBe(true);
    expect(instance.commands.setLink({ href: "https://example.com" })).toBe(true);
    expect(instance.getHTML()).toContain("<strong>");
    expect(instance.getHTML()).toContain("<em>");
    expect(instance.getHTML()).toContain("<u>");
    expect(instance.getHTML()).toContain('href="https://example.com"');

    instance.commands.setContent("<p>Section</p>");
    expect(instance.commands.toggleHeading({ level: 2 })).toBe(true);
    expect(instance.commands.setTextAlign("center")).toBe(true);
    expect(instance.getHTML()).toContain(
      '<h2 style="text-align: center;">Section</h2>',
    );
  });

  it("inserts editable tables and responsive resizable images", () => {
    const instance = createEditor();
    expect(
      instance.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true }),
    ).toBe(true);
    expect(instance.getHTML()).toContain("<table");
    expect(instance.getHTML()).toContain("<th");
    expect(instance.getHTML()).toContain("<td");

    instance.commands.setContent("<p>Before image</p>");
    expect(
      instance.commands.setImage({
        src: "data:image/png;base64,AA==",
        alt: "Sample",
        width: "50%",
        textAlign: "right",
      }),
    ).toBe(true);
    const imageHtml = instance.getHTML();
    expect(imageHtml).toContain('alt="Sample"');
    expect(imageHtml).toContain("width: 50%");
    expect(imageHtml).toContain("margin-left: auto");
    expect(imageHtml).toContain("max-width: 100%");
  });

  it("keeps display width separate from intrinsic Cloudflare dimensions", () => {
    const transformedImage =
      "https://cloud.scalius.com/cdn-cgi/image/width=600,height=600,fit=contain/products/example.webp";
    const instance = createEditor();
    expect(
      instance.commands.setImage({
        src: transformedImage,
        alt: "Example",
        width: "50%",
        textAlign: "right",
      }),
    ).toBe(true);

    const savedHtml = sanitizeHtml(instance.getHTML());
    expect(savedHtml).toContain('width="600"');
    expect(savedHtml).toContain("width: 50%");

    instance.commands.setContent(savedHtml);
    expect(instance.getHTML()).toContain("width: 50%");
    expect(instance.getHTML()).not.toContain("width: 600px");

    instance.commands.setContent(
      sanitizeHtml(`<img src="${transformedImage}" alt="Natural">`),
    );
    expect(instance.getHTML()).not.toContain("width: 600px");
  });

  it("preserves undo and redo history", () => {
    const instance = createEditor();
    instance.chain().focus("end").insertContent(" changed").run();
    expect(instance.getText()).toBe("First changed");
    expect(instance.commands.undo()).toBe(true);
    expect(instance.getText()).toBe("First");
    expect(instance.commands.redo()).toBe(true);
    expect(instance.getText()).toBe("First changed");
  });

  it("preserves selected text when inserting block media or a table", () => {
    const imageEditor = createEditor("<p>Keep this selected text</p>");
    imageEditor.commands.selectAll();
    expect(
      insertRichTextImage(imageEditor, {
        src: "https://cloud.scalius.com/media/example.webp",
        alt: "Example",
      }),
    ).toBe(true);
    expect(imageEditor.getText()).toContain("Keep this selected text");
    expect(imageEditor.getHTML()).toContain("<img");

    imageEditor.commands.setContent("<p>Keep this video text</p>");
    imageEditor.commands.selectAll();
    expect(
      insertRichTextVideo(imageEditor, {
        src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        provider: "youtube",
      }),
    ).toBe(true);
    expect(imageEditor.getText()).toContain("Keep this video text");
    expect(imageEditor.getHTML()).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");

    imageEditor.commands.setContent("<p>Keep this table text</p>");
    imageEditor.commands.selectAll();
    expect(
      insertRichTextTable(imageEditor, {
        rows: 2,
        cols: 2,
        withHeaderRow: true,
      }),
    ).toBe(true);
    expect(imageEditor.getText()).toContain("Keep this table text");
    expect(imageEditor.getHTML()).toContain("<table");
  });

  it("keeps consecutive block insertions on a valid text selection", () => {
    const instance = createEditor("<p>Before blocks</p>");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      insertRichTextVideo(instance, {
        src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        provider: "youtube",
      }),
    ).toBe(true);
    let videoPosition = -1;
    instance.state.doc.descendants((node, position) => {
      if (node.type.name === "videoEmbed") videoPosition = position;
    });
    expect(videoPosition).toBeGreaterThanOrEqual(0);
    expect(instance.commands.setNodeSelection(videoPosition)).toBe(true);
    expect(
      insertRichTextTable(instance, {
        rows: 2,
        cols: 2,
        withHeaderRow: true,
      }),
    ).toBe(true);

    expect(warning).not.toHaveBeenCalledWith(
      expect.stringContaining("TextSelection endpoint not pointing into a node with inline content"),
    );
  });
});
