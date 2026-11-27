// Whether a changed regular expression only widens, as a rule can prove it: from its structure, never
// from samples. A small, tested set of recognised widenings; any other change is a break (a security
// fix after the contract lock, or a new contract version). Imports nothing: the contract judge loads
// it with plain Node.
//
//   - one more alternative at the top level: `^(?:a|b)$` -> `^(?:a|b|c)$`;
//   - token by token the same, where a character class gains characters (`[a-z]` -> `[a-z0-9]`; a
//     negated class loses some) and a quantifier allows more (`{1,12}` -> `{1,80}`, `{2}` -> `{1,3}`,
//     `{1,n}` -> `+`).

type Token = { kind: "class"; negated: boolean; items: string[] } | { kind: "quant"; min: number; max: number } | { kind: "atom"; text: string };

/** The pattern's tokens, or null for anything this reader does not take apart (it then proves nothing). */
function tokens(source: string): Token[] | null {
  const out: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at]!;
    if (char === "\\") {
      const brace = /^\\[pPu]\{[^}]*\}/.exec(source.slice(at));
      const text = brace ? brace[0] : source.slice(at, at + 2);
      if (text.length < 2) return null;
      out.push({ kind: "atom", text });
      at += text.length;
    } else if (char === "[") {
      let end = at + 1;
      const negated = source[end] === "^";
      if (negated) end += 1;
      const items: string[] = [];
      let first = true;
      while (end < source.length && (source[end] !== "]" || first)) {
        first = false;
        let item = source[end] === "\\" ? source.slice(end, end + 2) : source[end]!;
        end += item.length;
        if (source[end] === "-" && source[end + 1] !== undefined && source[end + 1] !== "]") {
          const high = source[end + 1] === "\\" ? source.slice(end + 1, end + 3) : source[end + 1]!;
          item = `${item}-${high}`;
          end += 1 + high.length;
        }
        items.push(item);
      }
      if (source[end] !== "]") return null;
      out.push({ kind: "class", negated, items });
      at = end + 1;
    } else if (char === "{") {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
      if (!match) return null;
      const min = Number(match[1]);
      out.push({ kind: "quant", min, max: match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]) });
      at += match[0].length;
    } else if (char === "+" || char === "*" || char === "?") {
      out.push({ kind: "quant", min: char === "+" ? 1 : 0, max: char === "?" ? 1 : Infinity });
      at += 1;
    } else {
      out.push({ kind: "atom", text: char });
      at += 1;
    }
  }
  return out;
}

const single = (item: string) => !item.includes("-") || item.length <= 2;
const code = (item: string) => (item.startsWith("\\") ? null : item.codePointAt(0)!);

/** Whether a class item is matched by another (the same item, or a range holding it). */
function covered(item: string, by: string): boolean {
  if (item === by) return true;
  const [low, high] = single(by) ? [code(by), code(by)] : [code(by.split("-")[0]!), code(by.split("-").slice(1).join("-"))];
  const [from, to] = single(item) ? [code(item), code(item)] : [code(item.split("-")[0]!), code(item.split("-").slice(1).join("-"))];
  return low !== null && high !== null && from !== null && to !== null && low <= from && to <= high;
}

function tokenWidens(was: Token, now: Token): boolean {
  if (was.kind === "atom" && now.kind === "atom") return was.text === now.text;
  if (was.kind === "quant" && now.kind === "quant") return now.min <= was.min && now.max >= was.max;
  if (was.kind === "class" && now.kind === "class" && was.negated === now.negated) {
    // A class accepts more when it holds every item it held; a negated one, when it refuses no item it did not.
    return was.negated ? now.items.every((item) => was.items.some((by) => covered(item, by))) : was.items.every((item) => now.items.some((by) => covered(item, by)));
  }
  return false;
}

/** The top-level alternatives of an anchored pattern (`^(?:a|b)$` or `^a|b$` is not one), or null. */
function alternatives(source: string): { head: string; tail: string; options: string[] } | null {
  const match = /^(\^\(\?:)(.*)(\)\$)$/s.exec(source);
  if (!match) return null;
  const options: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  const body = match[2]!;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "|" && depth === 0) {
      options.push(body.slice(start, index));
      start = index + 1;
    }
  }
  options.push(body.slice(start));
  return depth === 0 ? { head: match[1]!, tail: match[3]!, options } : null;
}

/** True only when `after` provably matches every string `before` matches, and the two differ. */
export function patternWidens(before: string, after: string): boolean {
  if (before === after) return false;
  const was = alternatives(before);
  const now = alternatives(after);
  if (was && now && was.options.every((option) => now.options.includes(option))) return true;
  const a = tokens(before);
  const b = tokens(after);
  return a !== null && b !== null && a.length === b.length && a.every((token, index) => tokenWidens(token, b[index]!));
}
