/**
 * Which workspace importers a `pnpm-lock.yaml` change (or a workspace
 * `package.json` change) can reach, so `pnpm test:affected` selects those
 * packages' tests instead of the whole suite.
 *
 * An importer is affected when one of its direct dependency entries changed, or
 * when any snapshot in its transitive closure (in the old or the new lockfile)
 * changed or appeared or vanished. A workspace package that links an affected
 * one is affected too, and so is the root whenever anything is (its tests import
 * workspace source by relative path). Anything this module cannot read says "all".
 */
import YAML from "yaml";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const SNAPSHOT_FIELDS = ["dependencies", "optionalDependencies"];

/** @returns {object | undefined} the parsed lockfile, or undefined when it cannot be read. */
export function parseLock(text) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  try {
    const lock = YAML.parse(text);
    return lock && typeof lock === "object" && lock.importers && lock.snapshots ? lock : undefined;
  } catch {
    return undefined;
  }
}

/** `name@1.0.0(peer@2)` to `name@1.0.0`: the `packages:` key of a `snapshots:` key. */
function packageKey(snapshotKey) {
  const peer = snapshotKey.indexOf("(");
  return peer < 0 ? snapshotKey : snapshotKey.slice(0, peer);
}

/** The snapshot key a dependency entry `name: version` points at, or undefined for a link. */
function snapshotKeyOf(name, version) {
  if (typeof version !== "string" || version.startsWith("link:")) return undefined;
  if (version.startsWith("npm:")) return version.slice(4);
  // An alias (`typescript7: typescript@7.0.2`) names its target; a plain version starts with a digit.
  if (/^(?:@[^/@]+\/)?[^/@]+@/.test(version)) return version;
  return `${name}@${version}`;
}

function directEntries(importer) {
  const entries = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, entry] of Object.entries(importer?.[field] ?? {})) entries.set(`${field}:${name}`, JSON.stringify(entry));
  }
  return entries;
}

function closureOf(importer, lock) {
  const seen = new Set();
  const queue = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, entry] of Object.entries(importer?.[field] ?? {})) {
      const key = snapshotKeyOf(name, entry?.version);
      if (key) queue.push(key);
    }
  }
  while (queue.length > 0) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = lock.snapshots?.[key];
    for (const field of SNAPSHOT_FIELDS) {
      for (const [name, version] of Object.entries(snapshot?.[field] ?? {})) {
        const next = snapshotKeyOf(name, version);
        if (next && !seen.has(next)) queue.push(next);
      }
    }
  }
  return seen;
}

function fingerprint(lock, key) {
  const snapshot = lock.snapshots?.[key];
  if (!snapshot) return undefined;
  return JSON.stringify([snapshot, lock.packages?.[packageKey(key)]?.resolution]);
}

/** Snapshot keys whose content differs between the two lockfiles (added, removed or changed). */
function changedSnapshotKeys(base, head) {
  const changed = new Set();
  for (const key of new Set([...Object.keys(base.snapshots ?? {}), ...Object.keys(head.snapshots ?? {})])) {
    if (fingerprint(base, key) !== fingerprint(head, key)) changed.add(key);
  }
  return changed;
}

/** The given importers, the importers (keys such as "apps/api") that link them transitively, and the root when any. */
export function withDependents(importers, lock) {
  const affected = new Set(importers);
  const directory = (from, link) => {
    const parts = from === "." ? [] : from.split("/");
    for (const part of link.slice("link:".length).split("/")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    return parts.length === 0 ? "." : parts.join("/");
  };
  const links = new Map();
  for (const [from, importer] of Object.entries(lock.importers ?? {})) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const entry of Object.values(importer?.[field] ?? {})) {
        if (typeof entry?.version !== "string" || !entry.version.startsWith("link:")) continue;
        const target = directory(from, entry.version);
        links.set(target, [...(links.get(target) ?? []), from]);
      }
    }
  }
  const queue = [...affected];
  while (queue.length > 0) {
    for (const dependent of links.get(queue.pop()) ?? []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }
  // The root's tests (tests/, scripts/, rules/) import workspace source by relative path, so the
  // root depends on every package whether or not its manifest links it.
  if (affected.size > 0) affected.add(".");
  return affected;
}

/**
 * What a lockfile change reaches.
 * @returns {{ all: boolean, reason?: string, importers: Set<string>, rootDirect?: boolean }}
 */
export function lockImpact(baseText, headText) {
  const base = parseLock(baseText);
  const head = parseLock(headText);
  if (!base || !head) return { all: true, reason: "a lockfile could not be read", importers: new Set() };
  for (const field of ["lockfileVersion", "settings", "patchedDependencies"]) {
    if (JSON.stringify(base[field]) !== JSON.stringify(head[field])) {
      return { all: true, reason: `the lockfile ${field} changed`, importers: new Set() };
    }
  }
  const changedKeys = changedSnapshotKeys(base, head);
  const importers = new Set();
  let rootDirect = false;
  for (const name of new Set([...Object.keys(base.importers), ...Object.keys(head.importers)])) {
    const before = base.importers[name];
    const after = head.importers[name];
    let hit = !before || !after;
    if (!hit) {
      const left = directEntries(before);
      const right = directEntries(after);
      hit = left.size !== right.size || [...left].some(([key, value]) => right.get(key) !== value);
      if (hit && name === ".") rootDirect = true;
    }
    if (!hit && changedKeys.size > 0) {
      const closure = new Set([...closureOf(before, base), ...closureOf(after, head)]);
      hit = [...changedKeys].some((key) => closure.has(key));
    }
    if (hit) importers.add(name);
  }
  return { all: false, importers: withDependents(importers, head), rootDirect };
}

/** The importer keys of a lockfile, workspace root first. */
export function importerNames(lock) {
  return Object.keys(lock.importers ?? {});
}

/**
 * The test files that belong to the given importers. A file belongs to the
 * deepest importer directory that contains it; the root importer owns the rest.
 */
export function testsOfImporters(importers, allImporters, testFiles) {
  const directories = allImporters.filter((name) => name !== ".").sort((a, b) => b.length - a.length);
  return testFiles.filter((file) => {
    const owner = directories.find((directory) => file.startsWith(`${directory}/`)) ?? ".";
    return importers.has(owner);
  });
}
