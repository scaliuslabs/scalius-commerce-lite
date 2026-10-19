import { CliError } from "./errors.js";

// A built-in subset of jq for `--jq`, so agents can project and filter
// output without a second tool (as `gh --jq` does). Supported: paths
// (`.a.b`, `.["k"]`, `.[0]`, `.[]`, `.[1:3]`, `?`, `..`), pipes, `,`,
// literals, `[...]` and `{...}` construction, `//`, `and`/`or`,
// comparisons, arithmetic, `if/then/elif/else/end`, and the common
// builtins listed in FUNCTIONS.

type Node =
  | { kind: "identity" }
  | { kind: "recurse" }
  | { kind: "literal"; value: unknown }
  | { kind: "field"; target: Node; name: Node; optional: boolean }
  | { kind: "iterate"; target: Node; optional: boolean }
  | { kind: "slice"; target: Node; from: Node | null; to: Node | null; optional: boolean }
  | { kind: "pipe"; left: Node; right: Node }
  | { kind: "comma"; left: Node; right: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "array"; body: Node | null }
  | { kind: "object"; entries: Array<{ key: Node; value: Node }> }
  | { kind: "if"; branches: Array<{ condition: Node; then: Node }>; otherwise: Node | null }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "try"; body: Node };

interface Token {
  type: "punct" | "ident" | "field" | "string" | "number" | "format" | "eof";
  value: string;
  position: number;
}

const MAX_EXPRESSION = 2_000;
const MAX_OUTPUTS = 100_000;
const KEYWORDS = new Set(["if", "then", "elif", "else", "end", "and", "or", "true", "false", "null"]);

function fail(message: string): never {
  throw new CliError(2, "invalid_jq", `--jq: ${message}`);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const punctuation = ["//", "==", "!=", "<=", ">=", "..", "|", ",", ".", "[", "]", "(", ")", "{", "}", ":", ";", "?", "+", "-", "*", "/", "%", "<", ">"];
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "\"") {
      let end = index + 1;
      while (end < source.length && source[end] !== "\"") end += source[end] === "\\" ? 2 : 1;
      if (end >= source.length) fail("unterminated string");
      let value: string;
      try {
        value = JSON.parse(source.slice(index, end + 1)) as string;
      } catch {
        fail("invalid string escape");
      }
      tokens.push({ type: "string", value, position: index });
      index = end + 1;
      continue;
    }
    if (/\d/.test(character)) {
      const number = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))![0];
      tokens.push({ type: "number", value: number, position: index });
      index += number.length;
      continue;
    }
    if (character === "." && /[A-Za-z_]/.test(source[index + 1] ?? "")) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index + 1))![0];
      tokens.push({ type: "field", value: name, position: index });
      index += 1 + name.length;
      continue;
    }
    if (character === "@") {
      const name = /^[A-Za-z]+/.exec(source.slice(index + 1))?.[0];
      if (!name) fail(`unexpected '@' at ${index}`);
      tokens.push({ type: "format", value: name, position: index });
      index += 1 + name.length;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index))![0];
      tokens.push({ type: "ident", value: name, position: index });
      index += name.length;
      continue;
    }
    const symbol = punctuation.find((candidate) => source.startsWith(candidate, index));
    if (!symbol) fail(`unexpected '${character}' at ${index}`);
    tokens.push({ type: "punct", value: symbol, position: index });
    index += symbol.length;
  }
  tokens.push({ type: "eof", value: "", position: source.length });
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  private is(value: string, type: Token["type"] = "punct"): boolean {
    const token = this.peek();
    return token.type === type && token.value === value;
  }

  private expect(value: string, type: Token["type"] = "punct"): void {
    if (!this.is(value, type)) fail(`expected '${value}' at ${this.peek().position}`);
    this.next();
  }

  parse(): Node {
    const node = this.pipe();
    if (this.peek().type !== "eof") fail(`unexpected '${this.peek().value}' at ${this.peek().position}`);
    return node;
  }

  private pipe(): Node {
    const left = this.comma();
    if (this.is("|")) {
      this.next();
      return { kind: "pipe", left, right: this.pipe() };
    }
    return left;
  }

  private comma(): Node {
    let left = this.alternative();
    while (this.is(",")) {
      this.next();
      left = { kind: "comma", left, right: this.alternative() };
    }
    return left;
  }

  private alternative(): Node {
    const left = this.or();
    if (this.is("//")) {
      this.next();
      return { kind: "binary", op: "//", left, right: this.alternative() };
    }
    return left;
  }

  private or(): Node {
    let left = this.and();
    while (this.is("or", "ident")) {
      this.next();
      left = { kind: "binary", op: "or", left, right: this.and() };
    }
    return left;
  }

  private and(): Node {
    let left = this.comparison();
    while (this.is("and", "ident")) {
      this.next();
      left = { kind: "binary", op: "and", left, right: this.comparison() };
    }
    return left;
  }

  private comparison(): Node {
    const left = this.additive();
    for (const op of ["==", "!=", "<=", ">=", "<", ">"]) {
      if (this.is(op)) {
        this.next();
        return { kind: "binary", op, left, right: this.additive() };
      }
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    while (this.is("+") || this.is("-")) {
      const op = this.next().value;
      left = { kind: "binary", op, left, right: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.postfix();
    while (this.is("*") || this.is("/") || this.is("%")) {
      const op = this.next().value;
      left = { kind: "binary", op, left, right: this.postfix() };
    }
    return left;
  }

  private postfix(): Node {
    let node = this.primary();
    while (true) {
      const token = this.peek();
      if (token.type === "field") {
        this.next();
        node = { kind: "field", target: node, name: { kind: "literal", value: token.value }, optional: this.optional() };
      } else if (this.is(".") && this.tokens[this.index + 1]?.type === "string") {
        this.next();
        node = { kind: "field", target: node, name: { kind: "literal", value: this.next().value }, optional: this.optional() };
      } else if (this.is(".") && this.tokens[this.index + 1]?.value === "[" && this.tokens[this.index + 1]?.type === "punct") {
        this.next();
      } else if (this.is("[")) {
        node = this.bracket(node);
      } else if (this.is("?")) {
        this.next();
        node = { kind: "try", body: node };
      } else {
        return node;
      }
    }
  }

  private optional(): boolean {
    if (!this.is("?")) return false;
    this.next();
    return true;
  }

  private bracket(target: Node): Node {
    this.expect("[");
    if (this.is("]")) {
      this.next();
      return { kind: "iterate", target, optional: this.optional() };
    }
    if (this.is(":")) {
      this.next();
      const to = this.pipe();
      this.expect("]");
      return { kind: "slice", target, from: null, to, optional: this.optional() };
    }
    const index = this.pipe();
    if (this.is(":")) {
      this.next();
      const to = this.is("]") ? null : this.pipe();
      this.expect("]");
      return { kind: "slice", target, from: index, to, optional: this.optional() };
    }
    this.expect("]");
    return { kind: "field", target, name: index, optional: this.optional() };
  }

  private primary(): Node {
    const token = this.next();
    if (token.type === "field") {
      return { kind: "field", target: { kind: "identity" }, name: { kind: "literal", value: token.value }, optional: this.optional() };
    }
    if (token.type === "number") return { kind: "literal", value: Number(token.value) };
    if (token.type === "string") return { kind: "literal", value: token.value };
    if (token.type === "format") return { kind: "call", name: `@${token.value}`, args: [] };
    if (token.type === "punct") {
      switch (token.value) {
        case ".": {
          if (this.peek().type === "string") {
            return { kind: "field", target: { kind: "identity" }, name: { kind: "literal", value: this.next().value }, optional: this.optional() };
          }
          return { kind: "identity" };
        }
        case "..": return { kind: "recurse" };
        case "(": {
          const inner = this.pipe();
          this.expect(")");
          return inner;
        }
        case "[": {
          if (this.is("]")) {
            this.next();
            return { kind: "array", body: null };
          }
          const body = this.pipe();
          this.expect("]");
          return { kind: "array", body };
        }
        case "{": return this.object();
        case "-": return { kind: "binary", op: "-", left: { kind: "literal", value: 0 }, right: this.postfix() };
        default: fail(`unexpected '${token.value}' at ${token.position}`);
      }
    }
    if (token.type === "ident") {
      if (token.value === "true") return { kind: "literal", value: true };
      if (token.value === "false") return { kind: "literal", value: false };
      if (token.value === "null") return { kind: "literal", value: null };
      if (token.value === "if") return this.conditional();
      if (KEYWORDS.has(token.value)) fail(`unexpected '${token.value}' at ${token.position}`);
      const args: Node[] = [];
      if (this.is("(")) {
        this.next();
        args.push(this.pipe());
        while (this.is(";")) {
          this.next();
          args.push(this.pipe());
        }
        this.expect(")");
      }
      return { kind: "call", name: token.value, args };
    }
    fail("unexpected end of expression");
  }

  private conditional(): Node {
    const branches: Array<{ condition: Node; then: Node }> = [];
    const condition = this.pipe();
    this.expect("then", "ident");
    branches.push({ condition, then: this.pipe() });
    let otherwise: Node | null = null;
    while (this.is("elif", "ident")) {
      this.next();
      const next = this.pipe();
      this.expect("then", "ident");
      branches.push({ condition: next, then: this.pipe() });
    }
    if (this.is("else", "ident")) {
      this.next();
      otherwise = this.pipe();
    }
    this.expect("end", "ident");
    return { kind: "if", branches, otherwise };
  }

  private object(): Node {
    const entries: Array<{ key: Node; value: Node }> = [];
    while (!this.is("}")) {
      const token = this.next();
      let key: Node;
      let shorthand: Node | null = null;
      if (token.type === "ident" || token.type === "string") {
        key = { kind: "literal", value: token.value };
        shorthand = { kind: "field", target: { kind: "identity" }, name: key, optional: false };
      } else if (token.type === "punct" && token.value === "(") {
        key = this.pipe();
        this.expect(")");
      } else {
        fail(`invalid object key at ${token.position}`);
      }
      let value: Node;
      if (this.is(":")) {
        this.next();
        value = this.alternative();
      } else if (shorthand) {
        value = shorthand;
      } else {
        fail(`object key needs a value at ${token.position}`);
      }
      entries.push({ key, value });
      if (this.is(",")) this.next();
      else if (!this.is("}")) fail(`expected ',' or '}' at ${this.peek().position}`);
    }
    this.expect("}");
    return { kind: "object", entries };
  }
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

function typeOf(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "object";
}

const ORDER = ["null", "boolean", "number", "string", "array", "object"];

function compare(left: unknown, right: unknown): number {
  const leftType = typeOf(left);
  const rightType = typeOf(right);
  if (leftType !== rightType) return ORDER.indexOf(leftType) - ORDER.indexOf(rightType);
  switch (leftType) {
    case "null": return 0;
    case "boolean": return Number(left) - Number(right);
    case "number": return (left as number) - (right as number);
    case "string": return (left as string) < (right as string) ? -1 : (left as string) > (right as string) ? 1 : 0;
    case "array": {
      const a = left as unknown[];
      const b = right as unknown[];
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        const result = compare(a[index], b[index]);
        if (result !== 0) return result;
      }
      return a.length - b.length;
    }
    default: {
      const a = left as Record<string, unknown>;
      const b = right as Record<string, unknown>;
      const keys = compare(Object.keys(a).sort(), Object.keys(b).sort());
      if (keys !== 0) return keys;
      for (const key of Object.keys(a).sort()) {
        const result = compare(a[key], b[key]);
        if (result !== 0) return result;
      }
      return 0;
    }
  }
}

const truthy = (value: unknown) => value !== false && value !== null && value !== undefined;

function arithmetic(op: string, left: unknown, right: unknown): unknown {
  if (op === "+") {
    if (left === null || left === undefined) return right;
    if (right === null || right === undefined) return left;
    if (typeof left === "number" && typeof right === "number") return left + right;
    if (typeof left === "string" && typeof right === "string") return left + right;
    if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
    if (typeOf(left) === "object" && typeOf(right) === "object") return { ...(left as object), ...(right as object) };
  }
  if (op === "-") {
    if (typeof left === "number" && typeof right === "number") return left - right;
    if (Array.isArray(left) && Array.isArray(right)) return left.filter((item) => !right.some((other) => compare(item, other) === 0));
  }
  if (typeof left === "number" && typeof right === "number") {
    if (op === "*") return left * right;
    if (op === "/") {
      if (right === 0) fail("division by zero");
      return left / right;
    }
    if (op === "%") {
      if (Math.trunc(right) === 0) fail("modulo by zero");
      return Math.trunc(left) % Math.trunc(right);
    }
  }
  if (op === "/" && typeof left === "string" && typeof right === "string") return left.split(right);
  fail(`cannot apply '${op}' to ${typeOf(left)} and ${typeOf(right)}`);
}

function index(target: unknown, key: unknown, optional: boolean): unknown[] {
  if (target === null || target === undefined) return [null];
  if (typeof key === "string" && typeOf(target) === "object") {
    return [Object.hasOwn(target as object, key) ? (target as Record<string, unknown>)[key] : null];
  }
  if (typeof key === "number" && Array.isArray(target)) {
    const position = key < 0 ? target.length + Math.trunc(key) : Math.trunc(key);
    return [target[position] ?? null];
  }
  if (optional) return [];
  fail(`cannot index ${typeOf(target)} with ${typeOf(key)}`);
}

function csvField(value: unknown, separator: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") fail(`@csv/@tsv cannot format ${typeOf(value)}`);
  if (separator === "\t") return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
  return `"${value.replace(/"/g, "\"\"")}"`;
}

type Evaluator = (node: Node, input: unknown) => unknown[];

const FUNCTIONS: Record<string, (input: unknown, args: Node[], evaluate: Evaluator) => unknown[]> = {
  empty: () => [],
  not: (input) => [!truthy(input)],
  length: (input) => {
    if (input === null || input === undefined) return [0];
    if (typeof input === "string" || Array.isArray(input)) return [input.length];
    if (typeof input === "number") return [Math.abs(input)];
    if (typeof input === "object") return [Object.keys(input).length];
    fail(`${typeOf(input)} has no length`);
  },
  keys: (input) => {
    if (Array.isArray(input)) return [input.map((_, position) => position)];
    if (typeOf(input) === "object") return [Object.keys(input as object).sort()];
    fail(`${typeOf(input)} has no keys`);
  },
  keys_unsorted: (input) => typeOf(input) === "object" ? [Object.keys(input as object)] : FUNCTIONS.keys!(input, [], () => []),
  values: (input) => Array.isArray(input) ? [input] : typeOf(input) === "object" ? [Object.values(input as object)] : [],
  has: (input, args, evaluate) => evaluate(args[0]!, input).map((key) =>
    Array.isArray(input) ? typeof key === "number" && key >= 0 && key < input.length : typeOf(input) === "object" && Object.hasOwn(input as object, String(key))),
  map: (input, args, evaluate) => {
    if (!Array.isArray(input) && typeOf(input) !== "object") fail(`cannot map over ${typeOf(input)}`);
    const items = Array.isArray(input) ? input : Object.values(input as object);
    return [items.flatMap((item) => evaluate(args[0]!, item))];
  },
  map_values: (input, args, evaluate) => {
    if (Array.isArray(input)) return [input.map((item) => evaluate(args[0]!, item)[0] ?? null)];
    if (typeOf(input) !== "object") fail(`cannot map_values over ${typeOf(input)}`);
    return [Object.fromEntries(Object.entries(input as object).map(([key, item]) => [key, evaluate(args[0]!, item)[0] ?? null]))];
  },
  select: (input, args, evaluate) => evaluate(args[0]!, input).some(truthy) ? [input] : [],
  first: (input, args, evaluate) => args.length > 0 ? evaluate(args[0]!, input).slice(0, 1) : Array.isArray(input) ? [input[0] ?? null] : fail("first needs an array"),
  last: (input, args, evaluate) => args.length > 0 ? evaluate(args[0]!, input).slice(-1) : Array.isArray(input) ? [input[input.length - 1] ?? null] : fail("last needs an array"),
  limit: (input, args, evaluate) => evaluate(args[0]!, input).flatMap((count) => evaluate(args[1]!, input).slice(0, Math.max(0, Number(count)))),
  range: (input, args, evaluate) => {
    const bounds = args.map((arg) => Number(evaluate(arg, input)[0]));
    const [from, to] = bounds.length === 1 ? [0, bounds[0]!] : [bounds[0]!, bounds[1]!];
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > MAX_OUTPUTS) fail("range is out of bounds");
    return Array.from({ length: Math.max(0, Math.ceil(to - from)) }, (_, position) => from + position);
  },
  sort: (input) => Array.isArray(input) ? [[...input].sort(compare)] : fail("sort needs an array"),
  sort_by: (input, args, evaluate) => {
    if (!Array.isArray(input)) fail("sort_by needs an array");
    return [[...input].map((item) => ({ item, key: evaluate(args[0]!, item) })).sort((a, b) => compare(a.key, b.key)).map(({ item }) => item)];
  },
  group_by: (input, args, evaluate) => {
    if (!Array.isArray(input)) fail("group_by needs an array");
    const sorted = [...input].map((item) => ({ item, key: evaluate(args[0]!, item) })).sort((a, b) => compare(a.key, b.key));
    const groups: unknown[][] = [];
    let previous: unknown = Symbol("none");
    for (const { item, key } of sorted) {
      if (groups.length === 0 || compare(previous, key) !== 0) groups.push([]);
      groups[groups.length - 1]!.push(item);
      previous = key;
    }
    return [groups];
  },
  unique: (input) => Array.isArray(input) ? [[...input].sort(compare).filter((item, position, all) => position === 0 || compare(all[position - 1], item) !== 0)] : fail("unique needs an array"),
  unique_by: (input, args, evaluate) => {
    const groups = FUNCTIONS.group_by!(input, args, evaluate)[0] as unknown[][];
    return [groups.map((group) => group[0])];
  },
  min: (input) => Array.isArray(input) ? [input.length === 0 ? null : [...input].sort(compare)[0]] : fail("min needs an array"),
  max: (input) => Array.isArray(input) ? [input.length === 0 ? null : [...input].sort(compare)[input.length - 1]] : fail("max needs an array"),
  min_by: (input, args, evaluate) => { const sorted = FUNCTIONS.sort_by!(input, args, evaluate)[0] as unknown[]; return [sorted[0] ?? null]; },
  max_by: (input, args, evaluate) => { const sorted = FUNCTIONS.sort_by!(input, args, evaluate)[0] as unknown[]; return [sorted[sorted.length - 1] ?? null]; },
  add: (input) => {
    const items = Array.isArray(input) ? input : typeOf(input) === "object" ? Object.values(input as object) : fail("add needs an array");
    return [items.reduce<unknown>((sum, item) => arithmetic("+", sum, item), null)];
  },
  any: (input, args, evaluate) => Array.isArray(input) ? [input.some((item) => args.length > 0 ? evaluate(args[0]!, item).some(truthy) : truthy(item))] : fail("any needs an array"),
  all: (input, args, evaluate) => Array.isArray(input) ? [input.every((item) => args.length > 0 ? evaluate(args[0]!, item).some(truthy) : truthy(item))] : fail("all needs an array"),
  flatten: (input, args, evaluate) => {
    if (!Array.isArray(input)) fail("flatten needs an array");
    const depth = args.length > 0 ? Number(evaluate(args[0]!, input)[0]) : 1e9;
    return [input.flat(depth)];
  },
  reverse: (input) => Array.isArray(input) ? [[...input].reverse()] : typeof input === "string" ? [[...input].reverse().join("")] : [input],
  join: (input, args, evaluate) => {
    if (!Array.isArray(input)) fail("join needs an array");
    return evaluate(args[0]!, input).map((separator) => input.map((item) => item === null ? "" : typeof item === "object" ? fail("join needs scalars") : String(item)).join(String(separator)));
  },
  split: (input, args, evaluate) => typeof input === "string" ? evaluate(args[0]!, input).map((separator) => input.split(String(separator))) : fail("split needs a string"),
  ascii_downcase: (input) => typeof input === "string" ? [input.toLowerCase()] : fail("ascii_downcase needs a string"),
  ascii_upcase: (input) => typeof input === "string" ? [input.toUpperCase()] : fail("ascii_upcase needs a string"),
  ltrimstr: (input, args, evaluate) => evaluate(args[0]!, input).map((prefix) => typeof input === "string" && typeof prefix === "string" && input.startsWith(prefix) ? input.slice(prefix.length) : input),
  rtrimstr: (input, args, evaluate) => evaluate(args[0]!, input).map((suffix) => typeof input === "string" && typeof suffix === "string" && suffix && input.endsWith(suffix) ? input.slice(0, -suffix.length) : input),
  startswith: (input, args, evaluate) => evaluate(args[0]!, input).map((prefix) => typeof input === "string" && input.startsWith(String(prefix))),
  endswith: (input, args, evaluate) => evaluate(args[0]!, input).map((suffix) => typeof input === "string" && input.endsWith(String(suffix))),
  test: (input, args, evaluate) => evaluate(args[0]!, input).map((pattern) => {
    if (typeof input !== "string" || typeof pattern !== "string" || pattern.length > 200) fail("test needs a string and a pattern");
    const flags = args[1] ? String(evaluate(args[1], input)[0] ?? "") : "";
    return new RegExp(pattern, flags.replace(/[^imsu]/g, "")).test(input);
  }),
  contains: (input, args, evaluate) => evaluate(args[0]!, input).map((needle) => {
    const contains = (haystack: unknown, item: unknown): boolean => {
      if (typeof haystack === "string" && typeof item === "string") return haystack.includes(item);
      if (Array.isArray(haystack) && Array.isArray(item)) return item.every((element) => haystack.some((candidate) => contains(candidate, element)));
      if (typeOf(haystack) === "object" && typeOf(item) === "object") {
        return Object.entries(item as object).every(([key, value]) => Object.hasOwn(haystack as object, key) && contains((haystack as Record<string, unknown>)[key], value));
      }
      return compare(haystack, item) === 0;
    };
    return contains(input, needle);
  }),
  type: (input) => [typeOf(input)],
  tostring: (input) => [typeof input === "string" ? input : JSON.stringify(input ?? null)],
  tonumber: (input) => {
    const value = typeof input === "number" ? input : Number(input);
    if (typeof input !== "number" && (typeof input !== "string" || input.trim() === "" || !Number.isFinite(value))) fail(`cannot convert ${JSON.stringify(input)} to a number`);
    return [value];
  },
  tojson: (input) => [JSON.stringify(input ?? null)],
  fromjson: (input) => {
    if (typeof input !== "string") fail("fromjson needs a string");
    try {
      return [JSON.parse(input)];
    } catch {
      fail("fromjson: invalid JSON");
    }
  },
  to_entries: (input) => typeOf(input) === "object" ? [Object.entries(input as object).map(([key, value]) => ({ key, value }))] : fail("to_entries needs an object"),
  from_entries: (input) => Array.isArray(input) ? [Object.fromEntries(input.map((entry) => {
    const record = entry as Record<string, unknown>;
    return [String(record.key ?? record.k ?? record.name ?? ""), record.value ?? record.v ?? null];
  }))] : fail("from_entries needs an array"),
  with_entries: (input, args, evaluate) => {
    const entries = FUNCTIONS.to_entries!(input, [], evaluate)[0] as unknown[];
    return FUNCTIONS.from_entries!(entries.flatMap((entry) => evaluate(args[0]!, entry)), [], evaluate);
  },
  floor: (input) => typeof input === "number" ? [Math.floor(input)] : fail("floor needs a number"),
  ceil: (input) => typeof input === "number" ? [Math.ceil(input)] : fail("ceil needs a number"),
  round: (input) => typeof input === "number" ? [Math.round(input)] : fail("round needs a number"),
  abs: (input) => typeof input === "number" ? [Math.abs(input)] : fail("abs needs a number"),
  "@json": (input) => [JSON.stringify(input ?? null)],
  "@text": (input) => [typeof input === "string" ? input : JSON.stringify(input ?? null)],
  "@csv": (input) => Array.isArray(input) ? [input.map((item) => csvField(item, ",")).join(",")] : fail("@csv needs an array"),
  "@tsv": (input) => Array.isArray(input) ? [input.map((item) => csvField(item, "\t")).join("\t")] : fail("@tsv needs an array"),
};

function recurse(value: unknown, output: unknown[]): void {
  output.push(value);
  if (Array.isArray(value)) value.forEach((item) => recurse(item, output));
  else if (typeOf(value) === "object") Object.values(value as object).forEach((item) => recurse(item, output));
}

function evaluate(node: Node, input: unknown): unknown[] {
  switch (node.kind) {
    case "identity": return [input];
    case "recurse": {
      const output: unknown[] = [];
      recurse(input, output);
      return output;
    }
    case "literal": return [node.value];
    case "field": return evaluate(node.target, input).flatMap((target) =>
      evaluate(node.name, input).flatMap((key) => {
        try {
          return index(target, key, node.optional);
        } catch (error) {
          if (node.optional) return [];
          throw error;
        }
      }));
    case "iterate": return evaluate(node.target, input).flatMap((target) => {
      if (Array.isArray(target)) return target;
      if (typeOf(target) === "object") return Object.values(target as object);
      if (node.optional) return [];
      fail(`cannot iterate over ${typeOf(target)}`);
    });
    case "slice": return evaluate(node.target, input).map((target) => {
      if (target === null) return null;
      if (!Array.isArray(target) && typeof target !== "string") {
        if (node.optional) return undefined;
        fail(`cannot slice ${typeOf(target)}`);
      }
      const from = node.from ? Number(evaluate(node.from, input)[0]) : 0;
      const to = node.to ? Number(evaluate(node.to, input)[0]) : target.length;
      return target.slice(from, to);
    }).filter((value) => value !== undefined);
    case "pipe": return evaluate(node.left, input).flatMap((value) => evaluate(node.right, value));
    case "comma": return [...evaluate(node.left, input), ...evaluate(node.right, input)];
    case "binary": {
      if (node.op === "//") {
        const left = evaluate(node.left, input).filter(truthy);
        return left.length > 0 ? left : evaluate(node.right, input);
      }
      if (node.op === "and" || node.op === "or") {
        return evaluate(node.left, input).flatMap((left) => {
          if (node.op === "and" && !truthy(left)) return [false];
          if (node.op === "or" && truthy(left)) return [true];
          return evaluate(node.right, input).map(truthy);
        });
      }
      const rights = evaluate(node.right, input);
      const lefts = evaluate(node.left, input);
      return rights.flatMap((right) => lefts.map((left) => {
        switch (node.op) {
          case "==": return compare(left, right) === 0;
          case "!=": return compare(left, right) !== 0;
          case "<": return compare(left, right) < 0;
          case "<=": return compare(left, right) <= 0;
          case ">": return compare(left, right) > 0;
          case ">=": return compare(left, right) >= 0;
          default: return arithmetic(node.op, left, right);
        }
      }));
    }
    case "array": return [node.body ? evaluate(node.body, input) : []];
    case "object": {
      let results: Array<Record<string, unknown>> = [{}];
      for (const entry of node.entries) {
        const keys = evaluate(entry.key, input);
        const values = evaluate(entry.value, input);
        const next: Array<Record<string, unknown>> = [];
        for (const partial of results) {
          for (const key of keys) {
            if (typeof key !== "string") fail(`object keys must be strings, not ${typeOf(key)}`);
            for (const value of values) next.push({ ...partial, [key]: value });
          }
        }
        results = next;
      }
      return results;
    }
    case "if": {
      const [first, ...rest] = node.branches;
      return evaluate(first!.condition, input).flatMap((condition) => {
        if (truthy(condition)) return evaluate(first!.then, input);
        if (rest.length > 0) return evaluate({ kind: "if", branches: rest, otherwise: node.otherwise }, input);
        return node.otherwise ? evaluate(node.otherwise, input) : [input];
      });
    }
    case "call": {
      const implementation = FUNCTIONS[node.name];
      if (!implementation) fail(`unsupported function '${node.name}'`);
      return implementation(input, node.args, evaluate);
    }
    case "try": {
      try {
        return evaluate(node.body, input);
      } catch (error) {
        if (error instanceof CliError && error.errorCode === "invalid_jq") return [];
        throw error;
      }
    }
  }
}

/** Compiles a `--jq` expression once; the result runs it over one input. */
export function compileJq(source: string): (input: unknown) => unknown[] {
  if (source.length > MAX_EXPRESSION) fail(`expression longer than ${MAX_EXPRESSION} characters`);
  const program = new Parser(tokenize(source)).parse();
  return (input) => {
    const output = evaluate(program, input);
    if (output.length > MAX_OUTPUTS) fail(`more than ${MAX_OUTPUTS} results`);
    return output.map((value) => value === undefined ? null : value);
  };
}
