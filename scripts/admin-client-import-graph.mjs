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

  return stronglyConnectedComponents(graph)
    .filter((component) => component.length > 1 || graph.get(component[0])?.has(component[0]));
}

/**
 * Tarjan's strongly connected components of a directed graph
 * (Map<node, Iterable<node>>). Every node is in exactly one component.
 */
export function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!indexes.has(next)) {
        visit(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(next)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;

    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component);
  }

  for (const node of graph.keys()) {
    if (!indexes.has(node)) visit(node);
  }

  return components;
}
