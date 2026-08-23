import { dirname, resolve } from "node:path";

export function findStaticImportCycles(sources) {
  const files = new Set(sources.keys());
  const graph = new Map();
  const importPattern = /\b(?:import|export)(?:[^"'`]*?\bfrom\s*)?["'](\.\/[^"']+\.js)["']/g;

  for (const [file, source] of sources) {
    const imports = new Set();
    for (const match of source.matchAll(importPattern)) {
      const importedFile = resolve(dirname(file), match[1]);
      if (files.has(importedFile)) imports.add(importedFile);
    }
    graph.set(file, imports);
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
