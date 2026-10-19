// What a delivery place must be before a buyer may pick it: the rules the
// pack's dataset (../places) and its live Pathao refresh both apply, and the
// check the committed dataset passes (place-rules.test.ts). Pathao's feed
// carries a few rows that are not places (a test city typed "Dhakaaaaaaaa",
// a person's name with no thana under it); they stay in the dataset with
// their courier ids, switched off, so a store that loaded them turns them off
// too and no real place loses its id.
import type { PlaceEntry } from "./places";

/** Words a source uses for a row that is not a place (exact, case-folded). */
const NON_PLACE_NAMES = new Set([
  "lost", "n/a", "na", "none", "not applicable", "null", "undefined", "unknown",
  "test", "testing", "demo", "dummy", "sample", "temp", "tbd", "xxx", "asdf",
]);

/** A letter typed four or more times in a row: no place name in Bangladesh has one. */
const REPEATED_LETTER = /(\p{L})\1{3,}/iu;

/** Spelling kept; whitespace collapsed (as the store's place names are). */
export function normalizePlaceName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

/** A name no real place has: empty, a placeholder word, or a letter typed over and over. */
export function isJunkPlaceName(value: unknown): boolean {
  const name = normalizePlaceName(value);
  if (!name) return true;
  return NON_PLACE_NAMES.has(name.toLocaleLowerCase("en-US")) || REPEATED_LETTER.test(name);
}

/** Two sibling places are one when their names differ only by case, accents or spacing. */
export function placeNameIdentity(name: string): string {
  return normalizePlaceName(name).normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US");
}

export type PlaceProblemReason = "junk_name" | "duplicate_name" | "nothing_below";

export interface PlaceProblem {
  key: string;
  name: string;
  reason: PlaceProblemReason;
}

/**
 * The active places a buyer must not be offered: a junk name, a second
 * sibling with the same name but for case or accents (the first in dataset
 * order stays), and a top-level place with no active place below it (a city
 * with no thana is nowhere to deliver) when the dataset has deeper levels.
 */
export function placeDatasetProblems(entries: readonly PlaceEntry[]): PlaceProblem[] {
  const active = entries.filter((entry) => entry.active);
  const problems: PlaceProblem[] = [];
  const flagged = new Set<string>();
  const flag = (entry: PlaceEntry, reason: PlaceProblemReason) => {
    if (flagged.has(entry.key)) return;
    flagged.add(entry.key);
    problems.push({ key: entry.key, name: entry.name, reason });
  };
  for (const entry of active) if (isJunkPlaceName(entry.name)) flag(entry, "junk_name");
  const siblings = new Map<string, PlaceEntry>();
  for (const entry of active) {
    if (flagged.has(entry.key)) continue;
    const identity = `${entry.level}\u0000${entry.parent ?? ""}\u0000${placeNameIdentity(entry.name)}`;
    if (siblings.has(identity)) flag(entry, "duplicate_name");
    else siblings.set(identity, entry);
  }
  const deepest = Math.max(0, ...entries.map((entry) => entry.level));
  if (deepest > 1) {
    const parents = new Set(active.filter((entry) => !flagged.has(entry.key)).map((entry) => entry.parent));
    for (const entry of active) if (entry.level === 1 && !parents.has(entry.key)) flag(entry, "nothing_below");
  }
  return problems;
}

/**
 * The dataset with every problem place switched off (courier ids kept),
 * repeated until none is left: switching off a place can leave its parent
 * with nothing below.
 */
export function deactivatePlaceDatasetProblems<T extends PlaceEntry>(entries: readonly T[]): T[] {
  let current = [...entries];
  for (;;) {
    const problems = new Set(placeDatasetProblems(current).map((problem) => problem.key));
    if (problems.size === 0) return current;
    current = current.map((entry) => (problems.has(entry.key) ? { ...entry, active: false } : entry));
  }
}
