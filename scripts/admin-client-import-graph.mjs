import { dirname, resolve } from "node:path";

const STATIC_IMPORT_PATTERN = /\b(?:import|export)(?:[^"'`]*?\bfrom\s*)?["'](\.\/[^"']+\.js)["']/g;

/** Absolute paths of the sibling chunks a built chunk imports statically. */
export function staticChunkImports(file, source) {
  return [...source.matchAll(STATIC_IMPORT_PATTERN)].map((match) =>
    resolve(dirname(file), match[1]));
}

export function findStaticImportCycles(sources) {
  const files = new Set(sources.keys());
  const graph = new Map();

  for (const [file, source] of sources) {
    graph.set(file, new Set(staticChunkImports(file, source).filter((imported) => files.has(imported))));
  }

  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  function visit(file) {
    indexes.set(file, nextIndex);
    lowLinks.set(file, nextIndex);
    nextIndex += 1;
    stack.push(file);
    onStack.add(file);

    for (const importedFile of graph.get(file) ?? []) {
      if (!indexes.has(importedFile)) {
        visit(importedFile);
        lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(importedFile)));
      } else if (onStack.has(importedFile)) {
        lowLinks.set(file, Math.min(lowLinks.get(file), indexes.get(importedFile)));
      }
    }

    if (lowLinks.get(file) !== indexes.get(file)) return;

    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== file);

    if (component.length > 1 || graph.get(file)?.has(file)) cycles.push(component);
  }

  for (const file of files) {
    if (!indexes.has(file)) visit(file);
  }

  return cycles;
}
