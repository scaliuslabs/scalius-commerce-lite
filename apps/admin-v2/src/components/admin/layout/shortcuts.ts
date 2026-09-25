import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { shortcutsMessages } from "~/i18n/shortcuts";

type ShortcutsKey = keyof (typeof shortcutsMessages)["en"];

/** One key press: `mod` is ⌘ on a Mac and Ctrl elsewhere. */
export interface KeyCombo {
  key: string;
  mod?: boolean;
}

interface Shortcut {
  label: ShortcutsKey;
  /** Where it works: anywhere in the dashboard, or while editing. */
  group: "general" | "editing";
  combos: readonly KeyCombo[];
}

/**
 * Every keyboard shortcut the dashboard answers, declared once. The handlers
 * match events through `matchesShortcut()` and the `?` dialog lists this
 * table, so the two can't drift apart. Go-to sequences (G then a letter) live
 * in `GO_DEFAULTS` plus each staff member's own choices.
 */
export const SHORTCUTS = {
  search: { label: "search", group: "general", combos: [{ key: "k", mod: true }, { key: "s" }] },
  help: { label: "help", group: "general", combos: [{ key: "?" }] },
  navigation: { label: "navigation", group: "general", combos: [{ key: "b", mod: true }] },
  tableSearch: { label: "tableSearch", group: "general", combos: [{ key: "/" }] },
  cancel: { label: "cancel", group: "general", combos: [{ key: "escape" }] },
  save: { label: "save", group: "editing", combos: [{ key: "s", mod: true }] },
  submit: { label: "submit", group: "editing", combos: [{ key: "enter", mod: true }] },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type AnyKeyboardEvent = KeyboardEvent | ReactKeyboardEvent;

/** Whether the event is one of the shortcut's key presses (never with Alt; ⌘/Ctrl only when declared). */
export function matchesShortcut(id: ShortcutId, event: AnyKeyboardEvent): boolean {
  const mod = event.metaKey || event.ctrlKey;
  if (event.altKey) return false;
  return SHORTCUTS[id].combos.some((combo: KeyCombo) => {
    if (Boolean(combo.mod) !== mod) return false;
    if (combo.mod && event.shiftKey) return false;
    return event.key.toLowerCase() === combo.key;
  });
}

/** `aria-keyshortcuts` for a shortcut's key presses. */
export function ariaKeys(id: ShortcutId): string {
  return SHORTCUTS[id].combos
    .map((combo: KeyCombo) => [...(combo.mod ? [isMac ? "Meta" : "Control"] : []), combo.key.length === 1 ? combo.key.toUpperCase() : combo.key[0]!.toUpperCase() + combo.key.slice(1)].join("+"))
    .join(" ");
}

/** The caps shown for a key press: ["⌘", "K"], ["Ctrl", "Enter"], ["Esc"]. */
export function comboCaps(combo: KeyCombo): string[] {
  const key = combo.key === "escape" ? "Esc" : combo.key === "enter" ? "Enter" : combo.key.toUpperCase();
  return combo.mod ? [isMac ? "⌘" : "Ctrl", key] : [key];
}

/** Typing in a field (or a dialog) never triggers a page-wide shortcut. */
export function typingIn(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']"));
}

// ── Go-to sequences ─────────────────────────────────────────────────────────

/** The first key of every go-to sequence (Shopify's and Linear's). */
export const GO_KEY = "g";
export const SEQUENCE_MS = 1000;

/** Default sequences: destination → the key after G. */
export const GO_DEFAULTS: Readonly<Record<string, string>> = {
  "/admin": "h",
  "/admin/orders": "o",
  "/admin/inbox": "i",
  "/admin/products": "p",
  "/admin/customers": "c",
  "/admin/discounts": "d",
  "/admin/pages": "t",
  "/admin/online-store/theme": "w",
  "/admin/settings": "s",
};

/**
 * A staff member's stored choices: destination → `"g x"`, or `""` for a
 * default they turned off. Returns destination → key after G, choices first.
 */
export function goKeys(overrides: Readonly<Record<string, string>> | undefined): Map<string, string> {
  const chosen = Object.entries(overrides ?? {}).map(([to, sequence]) => [to, sequence.split(" ")[1] ?? ""] as const);
  const taken = new Set(chosen.map(([, key]) => key));
  // Defaults step aside for a destination the staff member set, and for a key they gave elsewhere.
  const keys = new Map(Object.entries(GO_DEFAULTS).filter(([to, key]) => !overrides?.[to] && overrides?.[to] !== "" && !taken.has(key)));
  for (const [to, key] of chosen) if (key) keys.set(to, key);
  return keys;
}

/** The stored form of a key after G. */
export function goSequence(key: string): string {
  return `${GO_KEY} ${key}`;
}

/** "G then O" caps for a key after G. */
export function goCaps(key: string): string[] {
  return [GO_KEY.toUpperCase(), key.toUpperCase()];
}
