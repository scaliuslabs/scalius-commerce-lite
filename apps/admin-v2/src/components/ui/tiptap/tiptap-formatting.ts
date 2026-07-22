import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";

function hasAtomNodeSelection(editor: Editor): boolean {
  const { selection } = editor.state;
  return selection instanceof NodeSelection && selection.node.isAtom;
}

export function canToggleRichTextList(editor: Editor): boolean {
  return !hasAtomNodeSelection(editor);
}

export function canToggleRichTextBlockquote(editor: Editor): boolean {
  return !hasAtomNodeSelection(editor) && (
    editor.isActive("bulletList") ||
    editor.isActive("orderedList") ||
    editor.can().toggleBlockquote()
  );
}

export function toggleRichTextBulletList(editor: Editor): boolean {
  if (!canToggleRichTextList(editor)) return false;
  return editor.chain().focus().toggleBulletList().run();
}

export function toggleRichTextOrderedList(editor: Editor): boolean {
  if (!canToggleRichTextList(editor)) return false;
  return editor.chain().focus().toggleOrderedList().run();
}

export function toggleRichTextBlockquote(editor: Editor): boolean {
  if (!canToggleRichTextBlockquote(editor)) return false;

  const chain = editor.chain().focus();
  if (editor.isActive("bulletList") || editor.isActive("orderedList")) {
    return chain.liftListItem("listItem").toggleBlockquote().run();
  }
  return chain.toggleBlockquote().run();
}
