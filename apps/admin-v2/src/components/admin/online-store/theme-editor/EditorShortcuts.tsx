/**
 * The theme editor's keyboard map, declared once (research P18: Shopify's
 * map plus Esc): the handler matches events through it and Ctrl+/ lists it.
 * The tree's own keys (arrows, Space to pick up, Alt+arrows) are listed with
 * them.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { isMac } from "~/components/admin/layout/shortcuts";

export interface EditorCombo {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export const EDITOR_SHORTCUTS = {
  undo: [{ key: "z", mod: true }],
  redo: [{ key: "z", mod: true, shift: true }, { key: "y", mod: true }],
  save: [{ key: "s", mod: true }],
  shortcuts: [{ key: "/", mod: true }],
  sidebar: [{ key: "\\" }],
  previous: [{ key: "ArrowUp", shift: true }],
  next: [{ key: "ArrowDown", shift: true }],
  back: [{ key: "Escape" }],
  duplicate: [{ key: "d", mod: true }],
  hide: [{ key: "h", mod: true, shift: true }],
  remove: [{ key: "Delete" }, { key: "Backspace" }],
} as const satisfies Record<string, readonly EditorCombo[]>;

export type EditorShortcut = keyof typeof EDITOR_SHORTCUTS;

/** Whether a key press (an event, or one the preview forwarded) is the shortcut. */
export function matchesEditorShortcut(id: EditorShortcut, press: { key: string; mod: boolean; shift: boolean; alt: boolean }): boolean {
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  return (EDITOR_SHORTCUTS[id] as readonly EditorCombo[]).some((combo) =>
    combo.key === key && Boolean(combo.mod) === press.mod && Boolean(combo.shift) === press.shift && Boolean(combo.alt) === press.alt);
}

const TREE_KEYS = [
  ["treeMove", ["↑", "↓"]],
  ["treeOpen", ["Enter"]],
  ["treeExpand", ["→", "←"]],
  ["treePickUp", ["Space"]],
  ["treeMoveAtOnce", ["Alt ↑", "Alt ↓"]],
  ["treeMenu", ["Shift F10"]],
] as const;

function caps(combo: EditorCombo): string {
  const key = combo.key === "ArrowUp" ? "↑" : combo.key === "ArrowDown" ? "↓" : combo.key === "Escape" ? "Esc" : combo.key.length === 1 ? combo.key.toUpperCase() : combo.key;
  return [...(combo.shift ? ["Shift"] : []), ...(combo.mod ? [isMac ? "⌘" : "Ctrl"] : []), ...(combo.alt ? ["Alt"] : []), key].join(" ");
}

/** A shortcut's keys as the top bar's tooltips show them ("⌘ Z", "Ctrl Z"). */
export function shortcutCaps(id: EditorShortcut): string {
  return caps(EDITOR_SHORTCUTS[id][0]);
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(themeEditorMessages);
  const rows = (Object.keys(EDITOR_SHORTCUTS) as EditorShortcut[]).map((id) => [t(`shortcut_${id}`), (EDITOR_SHORTCUTS[id] as readonly EditorCombo[]).map(caps)] as const);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-editor-shortcuts>
        <DialogHeader>
          <DialogTitle>{t("shortcuts")}</DialogTitle>
        </DialogHeader>
        <table className="w-full text-body">
          <tbody>
            {rows.map(([label, keys]) => (
              <tr key={label} className="border-b border-border last:border-b-0">
                <td className="py-1.5 pe-3">{label}</td>
                <td className="py-1.5 text-end">{keys.map((key) => <kbd key={key} className="ms-1">{key}</kbd>)}</td>
              </tr>
            ))}
            <tr><td colSpan={2} className="pt-3 font-medium">{t("shortcutsTree")}</td></tr>
            {TREE_KEYS.map(([label, keys]) => (
              <tr key={label} className="border-b border-border last:border-b-0">
                <td className="py-1.5 pe-3">{t(label)}</td>
                <td className="py-1.5 text-end">{keys.map((key) => <kbd key={key} className="ms-1">{key}</kbd>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
