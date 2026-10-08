/**
 * The three-way field merge editors use when a save meets a newer revision
 * (docs/platform/REALTIME.md, "Merge rules"):
 *
 *   base   = the version the editor loaded,
 *   theirs = the version saved since (the current one),
 *   mine   = the editor's draft.
 *
 * A field only one side changed takes that side. A field both sides changed
 * to the same value is not a clash. A field both changed differently is a
 * clash the merchant decides. Coupled fields (a product's prices and its
 * variant composition, which share the aggregate revision) merge as one
 * unit: when both sides touched any field of the group, the whole group is
 * one clash, never a silent mix of the two versions.
 *
 * Plain objects merge field by field below the top level (settings documents
 * nest); arrays and other values are atomic.
 */

export type MergeChoice = "theirs" | "mine";

export interface MergeClash {
  /** The field path, or the group's name for a coupled group. */
  key: string;
  /** The paths this clash decides (one, or every changed field of the group). */
  paths: string[];
  base: Record<string, unknown>;
  theirs: Record<string, unknown>;
  mine: Record<string, unknown>;
}

export interface MergeResult<T> {
  /** Every change applied; each clash still holds the saved (theirs) value. */
  merged: T;
  clashes: MergeClash[];
  /** Paths the draft changed (what the save will write). */
  mineChanged: string[];
  /** Paths the other save changed. */
  theirsChanged: string[];
}

export interface MergeOptions {
  /** Top-level fields that change together; at most one side's version of a group survives. */
  coupled?: Readonly<Record<string, readonly string[]>>;
  /** Top-level fields to compare; by default every field of the three versions. */
  fields?: readonly string[];
  /** Merge plain objects field by field (default true). */
  deep?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Structural equality for JSON-like values (key order ignored). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if ((a === undefined || a === null) && (b === undefined || b === null)) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!sameValue(a[key], b[key])) return false;
    return true;
  }
  return false;
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setPath<T>(target: T, path: string[], next: unknown): T {
  if (path.length === 0) return next as T;
  const [head, ...rest] = path;
  const source = isPlainObject(target) ? target : {};
  return { ...source, [head!]: setPath(source[head!], rest, next) } as T;
}

/** Leaf paths where the two versions differ (plain objects descend; other values are leaves). */
function changedPaths(base: unknown, other: unknown, prefix: string[], deep: boolean, out: string[][]): void {
  if (sameValue(base, other)) return;
  if (deep && prefix.length > 0 && isPlainObject(base) && isPlainObject(other)) {
    for (const key of new Set([...Object.keys(base), ...Object.keys(other)])) {
      changedPaths(base[key], other[key], [...prefix, key], deep, out);
    }
    return;
  }
  out.push(prefix);
}

function topLevelPaths(base: object, other: object, fields: readonly string[] | undefined, deep: boolean): string[][] {
  const keys = fields ?? [...new Set([...Object.keys(base), ...Object.keys(other)])];
  const out: string[][] = [];
  for (const key of keys) {
    changedPaths((base as Record<string, unknown>)[key], (other as Record<string, unknown>)[key], [key], deep, out);
  }
  return out;
}

const join = (path: string[]) => path.join(".");

export function threeWayMerge<T extends object>(base: T, theirs: T, mine: T, options: MergeOptions = {}): MergeResult<T> {
  const deep = options.deep ?? true;
  const groups = Object.entries(options.coupled ?? {});
  const groupOf = (path: string[]) => groups.find(([, fields]) => fields.includes(path[0]!))?.[0] ?? null;
  const mineList = topLevelPaths(base, mine, options.fields, deep);
  const theirsList = topLevelPaths(base, theirs, options.fields, deep);
  const theirsSet = new Set(theirsList.map(join));

  let merged = theirs;
  const clashes: MergeClash[] = [];
  const clashedGroups = new Set<string>();
  const snapshot = (paths: string[][]) => ({
    base: Object.fromEntries(paths.map((path) => [join(path), getPath(base, path)])),
    theirs: Object.fromEntries(paths.map((path) => [join(path), getPath(theirs, path)])),
    mine: Object.fromEntries(paths.map((path) => [join(path), getPath(mine, path)])),
  });

  // Coupled groups first: both sides touched the group → one clash for all of it.
  for (const [name, fields] of groups) {
    const inGroup = (path: string[]) => fields.includes(path[0]!);
    const mineIn = mineList.filter(inGroup);
    const theirsIn = theirsList.filter(inGroup);
    if (mineIn.length === 0 || theirsIn.length === 0) continue;
    const all = [...new Map([...mineIn, ...theirsIn].map((path) => [join(path), path])).values()];
    const agree = all.every((path) => sameValue(getPath(mine, path), getPath(theirs, path)));
    if (agree) continue;
    clashedGroups.add(name);
    clashes.push({ key: name, paths: all.map(join), ...snapshot(all) });
  }

  for (const path of mineList) {
    const group = groupOf(path);
    if (group && clashedGroups.has(group)) continue;
    const mineValue = getPath(mine, path);
    if (theirsSet.has(join(path)) && !group) {
      if (sameValue(mineValue, getPath(theirs, path))) continue;
      clashes.push({ key: join(path), paths: [join(path)], ...snapshot([path]) });
      continue;
    }
    merged = setPath(merged, path, mineValue);
  }

  return {
    merged,
    clashes,
    mineChanged: mineList.map(join),
    theirsChanged: theirsList.map(join),
  };
}

/** Applies the merchant's choice per clash (a missing choice keeps the saved version). */
export function resolveMerge<T extends object>(result: MergeResult<T>, choices: Readonly<Record<string, MergeChoice>>): T {
  let merged = result.merged;
  for (const clash of result.clashes) {
    if (choices[clash.key] !== "mine") continue;
    for (const path of clash.paths) merged = setPath(merged, path.split("."), clash.mine[path]);
  }
  return merged;
}
