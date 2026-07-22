import type { Editor } from "@tiptap/core";

interface RichTextImageAttributes {
  src: string;
  alt?: string;
  title?: string;
  width?: string;
  textAlign?: string;
}

interface RichTextVideoAttributes {
  src: string;
  provider: "youtube" | "vimeo";
  title?: string;
}

function blockInsertionChain(editor: Editor) {
  const insertionPosition = editor.state.selection.to;
  return editor.chain().focus().setTextSelection(insertionPosition);
}

/** Inserts block media without deleting a non-collapsed text selection. */
export function insertRichTextImage(
  editor: Editor,
  attributes: RichTextImageAttributes,
): boolean {
  return blockInsertionChain(editor).setImage(attributes).run();
}

/** Inserts a video block without deleting a non-collapsed text selection. */
export function insertRichTextVideo(
  editor: Editor,
  attributes: RichTextVideoAttributes,
): boolean {
  return blockInsertionChain(editor).setVideoEmbed(attributes).run();
}

/** Inserts a table without replacing selected merchant-authored content. */
export function insertRichTextTable(
  editor: Editor,
  options: { rows: number; cols: number; withHeaderRow: boolean },
): boolean {
  return blockInsertionChain(editor).insertTable(options).run();
}
