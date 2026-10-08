/**
 * Asks the merchant to settle a real same-field clash after a three-way merge
 * (lib/three-way-merge.ts). One dialog for every editor: the admin frame
 * mounts `MergeChoiceHost` (components/admin/realtime/MergeChoiceDialog.tsx),
 * and an editor awaits `requestMergeChoice`. Resolves with a choice per clash,
 * or null when the merchant cancels (the editor then keeps its draft unsaved).
 */
import type { MergeChoice } from "./three-way-merge";

export interface MergeChoiceRow {
  key: string;
  /** The field's label as the editor shows it. */
  label: string;
  /** Display text of the saved version and of the merchant's. */
  theirs: string;
  mine: string;
  /** More than one field changes with this choice (a coupled group). */
  coupled?: boolean;
}

export interface MergeChoiceRequest {
  rows: MergeChoiceRow[];
  /** Who saved, when the editor knows (presence). */
  savedBy?: string | null;
}

type Pending = { request: MergeChoiceRequest; resolve: (choices: Record<string, MergeChoice> | null) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function requestMergeChoice(request: MergeChoiceRequest): Promise<Record<string, MergeChoice> | null> {
  if (listeners.size === 0) return Promise.resolve(null);
  // A second request replaces an unanswered first one (that editor cancels).
  pending?.resolve(null);
  return new Promise((resolve) => {
    pending = { request, resolve };
    notify();
  });
}

export function currentMergeChoice(): Pending | null {
  return pending;
}

export function answerMergeChoice(choices: Record<string, MergeChoice> | null): void {
  const current = pending;
  pending = null;
  current?.resolve(choices);
  notify();
}

export function subscribeMergeChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Short display text for a field value (the dialog truncates long text with CSS). */
export function mergeDisplayValue(value: unknown, words: { empty: string; on: string; off: string; items: (count: number) => string; number: (value: number) => string }): string {
  if (value === null || value === undefined || value === "") return words.empty;
  if (typeof value === "boolean") return value ? words.on : words.off;
  if (typeof value === "number") return words.number(value);
  if (typeof value === "string") {
    const text = value.includes("<") ? value.replace(/<[^>]*>/g, " ") : value;
    return text.replace(/\s+/g, " ").trim() || words.empty;
  }
  if (Array.isArray(value)) return words.items(value.length);
  try {
    return JSON.stringify(value);
  } catch {
    return words.empty;
  }
}
