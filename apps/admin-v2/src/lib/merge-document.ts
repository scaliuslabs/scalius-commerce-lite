/**
 * The merge an editor runs when a save meets a newer revision
 * (docs/platform/REALTIME.md, "Merge rules"). Loaded only then (`import()`),
 * so editors pay nothing for it until two saves meet.
 */
import { formatNumber, translate } from "~/i18n";
import { realtimeMessages } from "~/i18n/realtime";
import { mergeDisplayValue, requestMergeChoice, type MergeChoiceRow } from "./merge-choice";
import { resolveMerge, threeWayMerge, type MergeClash, type MergeOptions } from "./three-way-merge";

export { mergeDisplayValue, requestMergeChoice, resolveMerge, threeWayMerge };

/** Words for showing a value in the side-by-side choice. */
export function mergeWords() {
  return {
    empty: translate(realtimeMessages, "emptyValue"),
    on: translate(realtimeMessages, "valueOn"),
    off: translate(realtimeMessages, "valueOff"),
    items: (count: number) => translate(realtimeMessages, "valueItems", { count }),
    number: (value: number) => formatNumber(value),
  };
}

/** The toast after a save that combined two saves. */
export function mergedMessage(): string {
  return translate(realtimeMessages, "merged");
}

/** One side-by-side row per clash, with the editor's labels and value formatting. */
export function clashRows(
  clashes: readonly MergeClash[],
  label: (path: string) => string,
  show: (path: string, value: unknown) => string = (_path, value) => mergeDisplayValue(value, mergeWords()),
): MergeChoiceRow[] {
  return clashes.map((clash) => ({
    key: clash.key,
    label: [...new Set(clash.paths.map(label))].join(", "),
    theirs: clash.paths.map((path) => show(path, clash.theirs[path])).join(" · "),
    mine: clash.paths.map((path) => show(path, clash.mine[path])).join(" · "),
    coupled: clash.paths.length > 1,
  }));
}

/** The label the page shows for a field: its control's `<label>`, else the key in words. */
export function fieldLabel(path: string, fields: Record<string, string> | ((path: string) => string | undefined) | undefined): string {
  const lookup = (key: string) => typeof fields === "function" ? fields(key) : fields?.[key];
  const controlId = lookup(path) ?? lookup(path.split(".")[0]!);
  if (controlId && typeof document !== "undefined" && typeof CSS !== "undefined") {
    const text = document.querySelector(`label[for="${CSS.escape(controlId)}"]`)?.textContent?.trim();
    if (text) return text;
  }
  const last = path.split(".").pop() ?? path;
  const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A settings document's three-way merge: the merged values, or null when the
 * merchant cancelled the choice for a real same-field clash.
 */
export async function mergeSettingsDraft<T extends object>(
  base: T,
  theirs: T,
  mine: T,
  options: { coupled?: MergeOptions["coupled"]; fields?: Record<string, string> | ((path: string) => string | undefined) },
): Promise<T | null> {
  const result = threeWayMerge(base, theirs, mine, { coupled: options.coupled });
  if (result.clashes.length === 0) return result.merged;
  const choices = await requestMergeChoice({ rows: clashRows(result.clashes, (path) => fieldLabel(path, options.fields)) });
  return choices ? resolveMerge(result, choices) : null;
}
