import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

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
  const insertionPosition = TextSelection.near(
    editor.state.doc.resolve(editor.state.selection.to),
    1,
  ).from;
  // Media pickers and popovers temporarily make the editor background inert.
  // The document transaction does not need DOM focus; callers restore focus
  // after their overlay has closed.
  return editor.chain().setTextSelection(insertionPosition);
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
