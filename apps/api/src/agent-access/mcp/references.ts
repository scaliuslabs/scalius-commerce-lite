const REFERENCE_KEY = "$step";
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/;
const MAX_REFERENCE_COUNT = 100;
const MAX_REFERENCE_DEPTH = 32;
const MAX_EXPANDED_BYTES = 1024 * 1024;
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface AgentStepReference {
  $step: string;
  pointer?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isStepReference(value: unknown): value is AgentStepReference {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.every((key) => key === REFERENCE_KEY || key === "pointer") &&
    typeof value.$step === "string" &&
    value.$step.length > 0 &&
    (value.pointer === undefined ||
      (typeof value.pointer === "string" && JSON_POINTER_PATTERN.test(value.pointer)))
  );
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function readJsonPointer(value: unknown, pointer = ""): unknown {
  if (!JSON_POINTER_PATTERN.test(pointer)) throw new Error("Invalid JSON Pointer");
  if (!pointer) return value;
  let current = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = unescapePointerToken(rawToken);
    if (POISON_KEYS.has(token)) throw new Error("Reference target key is forbidden");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error("Reference target is missing");
      current = current[Number(token)];
    } else if (isPlainRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      throw new Error("Reference target is missing");
    }
  }
  return current;
}

export function resolveStepReferences(
  value: unknown,
  completed: ReadonlyMap<string, unknown>,
  state: { count: number; seen: WeakSet<object> } = {
    count: 0,
    seen: new WeakSet<object>(),
  },
  depth = 0,
): unknown {
  if (depth > MAX_REFERENCE_DEPTH) throw new Error("Reference nesting exceeds 32 levels");
  if (isStepReference(value)) {
    state.count += 1;
    if (state.count > MAX_REFERENCE_COUNT) throw new Error("Reference count exceeds 100");
    if (!completed.has(value.$step)) throw new Error("Reference must name an earlier step");
    return structuredClone(readJsonPointer(completed.get(value.$step), value.pointer));
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) throw new Error("Reference input must not be cyclic");
    state.seen.add(value);
    return value.map((item) => resolveStepReferences(item, completed, state, depth + 1));
  }
  if (isPlainRecord(value)) {
    if (state.seen.has(value)) throw new Error("Reference input must not be cyclic");
    state.seen.add(value);
    const entries = Object.entries(value).map(([key, item]) => {
      if (POISON_KEYS.has(key)) throw new Error("Reference input key is forbidden");
      return [key, resolveStepReferences(item, completed, state, depth + 1)] as const;
    });
    const resolved = Object.fromEntries(entries);
    const serialized = JSON.stringify(resolved);
    if (new TextEncoder().encode(serialized).byteLength > MAX_EXPANDED_BYTES) {
      throw new Error("Reference expansion exceeds 1 MiB");
    }
    return resolved;
  }
  return value;
}

export function containsStepReference(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    visited += 1;
    if (visited > 10_000) throw new Error("Reference input is too complex");
    if (current.depth > MAX_REFERENCE_DEPTH) {
      throw new Error("Reference nesting exceeds 32 levels");
    }
    if (isStepReference(current.value)) return true;
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) throw new Error("Reference input must not be cyclic");
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (isPlainRecord(current.value)) {
      for (const [key, item] of Object.entries(current.value)) {
        if (POISON_KEYS.has(key)) throw new Error("Reference input key is forbidden");
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
  return false;
}
