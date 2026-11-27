// The compatibility rules of the theme seals that `vitest -u` used to accept
// after review alone (compat.test.ts, private-layout.test.ts,
// save-reasons.test.ts). Until the contract lock they still do; from the lock
// on, every line these rules give needs a typed entry in
// packages/shared/src/contract/contract.breaks.json (contract/lock.ts).
import { jsonSchemaBreakingChanges } from "../schema-compat";
import { growOnlyBreaks, refusalListBreaks } from "../contract/rules";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const number = (value: unknown) => (typeof value === "number" ? value : 0);

/**
 * The theme document (`compat.snapshot.json`): a stored theme, template or
 * page preset is written earlier and read later, so the read accepts no less
 * (request rules) within a version. A raised document or section version is
 * the other way to change a shape: its upgrade step and frozen golden carry
 * the old documents (compat.test.ts checks both), so its settings are not
 * compared across the bump. The oldest readable version never rises, no
 * section type goes, and translatable text paths only grow.
 */
export function themeContractBreakingChanges(before: unknown, after: unknown): string[] {
  const was = record(before);
  const now = record(after);
  const problems: string[] = [];
  if (number(now.version) < number(was.version)) problems.push(`version: went back from ${String(was.version)} to ${String(now.version)}.`);
  if (number(now.oldestReadable) > number(was.oldestReadable)) {
    problems.push(`oldestReadable: rose from ${String(was.oldestReadable)} to ${String(now.oldestReadable)}: a stored theme of an older version is no longer read.`);
  }
  if (now.version === was.version) problems.push(...jsonSchemaBreakingChanges(was.document, now.document, "request").map((line) => `document ${line}`));
  const sections = record(now.sections);
  for (const [type, entry] of Object.entries(record(was.sections))) {
    const next = record(sections[type]);
    if (!(type in sections)) {
      problems.push(`sections.${type}: the section type was removed.`);
      continue;
    }
    const previous = record(entry);
    if (number(next.version) < number(previous.version)) problems.push(`sections.${type}.version: went back from ${String(previous.version)} to ${String(next.version)}.`);
    if (next.version === previous.version && now.version === was.version) {
      problems.push(...jsonSchemaBreakingChanges(previous.settings, next.settings, "request").map((line) => `sections.${type} settings ${line}`));
    }
    problems.push(...growOnlyBreaks(`sections.${type}.text`, previous.text ?? [], next.text ?? []));
  }
  problems.push(...growOnlyBreaks("text", was.text ?? {}, now.text ?? {}));
  return problems;
}

/** A line of the private anatomy: its subject (`cart part lines`), its `key=value` attributes and its bare flags. */
interface AnatomyLine {
  kind: string;
  attributes: Map<string, string>;
  flags: Set<string>;
  /** A line whose words are its value (`cart lead lines,summary`, `cart fields in a,b`). */
  list: string[] | null;
}

/** Attributes whose `a,b` or `a|b` lists only grow: what a theme names. */
const GROWS = new Set(["hooks", "variants", "tokens", "targets", "frames", "attributes", "holds", "controls", "tones", "data-private", "data-part"]);
/** Attributes and line kinds that are rules a theme must meet: a new member is a new refusal, a removed one refuses less. */
const RULES = new Set(["outranks", "lead"]);
/** Flags a theme must then meet (a part becomes mandatory, a label may hold no figures): appearing refuses, going refuses less. */
const RULE_FLAGS = new Set(["mandatory", "no-figures"]);

/** The bare flags a line carries; any other bare word on a style line is its selector. */
const LINE_FLAGS = new Set([...RULE_FLAGS, "fields"]);

const members = (value: string) => value.split(/[,|]/).filter(Boolean);

/** The anatomy lines by subject. Several lines may share one (`cart layout fold hooks=…` and `… holds=…`). */
function anatomy(text: string): Map<string, AnatomyLine> {
  const lines = new Map<string, AnatomyLine>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const words = raw.trim().split(" ");
    let subject: string[];
    let rest: string[];
    let list: string[] | null = null;
    if (words[0] === "token") {
      // `token <name> <JSON Schema>`: a token's type, the values a theme may give it.
      subject = words.slice(0, 2);
      rest = [`schema=${words.slice(2).join(" ")}`];
    } else if (words[1] === "style" && words[0] === "buyer-ui") {
      // `buyer-ui style ui.text[.neutral|info][@<app>][/<target>] kind tokens=…`: the tones ride the name.
      const [name, tones] = (words[2] ?? "").split(/\[\.([^\]]*)\]/);
      subject = [words[0]!, words[1]!, name!];
      rest = [...(tones ? [`tones=${tones}`] : []), ...words.slice(3)];
    } else if (words[1] === "style" || words[1] === "part" || words[1] === "label" || words[1] === "layout" || words[1] === "target" || words[1] === "icon") {
      subject = words.slice(0, 3);
      // A style's selector is the host's (a theme names the style, never the selector it compiles to).
      rest = words.slice(3).filter((word) => /^[a-z][a-z-]*=/.test(word) || LINE_FLAGS.has(word));
    } else if (words[1] === "fields" || words[1] === "layouts" || words[1] === "lead") {
      subject = words.slice(0, words[1] === "fields" ? 3 : 2);
      list = members(words[words.length - 1] ?? "");
      rest = [];
    } else if (words[1] === "order") {
      subject = words;
      rest = [];
    } else {
      const at = words.findIndex((word, index) => index > 0 && word.includes("="));
      subject = at < 0 ? words : words.slice(0, at);
      rest = at < 0 ? [] : words.slice(at);
    }
    const key = subject.join(" ");
    const line = lines.get(key) ?? { kind: words[1] ?? "", attributes: new Map(), flags: new Set(), list };
    for (const word of rest) {
      const equals = word.indexOf("=");
      if (equals > 0) line.attributes.set(word.slice(0, equals), word.slice(equals + 1));
      else line.flags.add(word);
    }
    lines.set(key, line);
  }
  return lines;
}

/** Each private token's type as an anatomy line (`token radius {"type":"integer",…}`): what values a theme may give it. */
export function privateTokenTypeLines(types: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(types).map(([name, schema]) => `token ${name} ${JSON.stringify(schema)}`);
}

/**
 * The private pages' anatomy (`private-anatomy.snapshot.txt`): what a theme
 * names only grows (pages, parts, targets, variants, hooks, style names and
 * their tokens, label keys and icons, layouts); what a theme must meet only
 * loosens (a part made mandatory, a new ordering rule, a label's maximum
 * falling or losing its figures, a new outranking pair are new refusals).
 * A token's type (`token` lines) accepts no less.
 */
export function privateAnatomyBreakingChanges(before: string, after: string): string[] {
  const was = anatomy(before);
  const now = anatomy(after);
  const problems: string[] = [];
  for (const [subject, line] of was) {
    const next = now.get(subject);
    if (!next) {
      if (line.kind !== "order") problems.push(`${subject}: removed.`);
      continue;
    }
    if (line.list) {
      problems.push(...(RULES.has(line.kind) ? refusalListBreaks(subject, line.list, next.list ?? []) : growOnlyBreaks(subject, line.list, next.list ?? [])));
    }
    for (const [name, value] of line.attributes) {
      const nextValue = next.attributes.get(name);
      if (GROWS.has(name)) problems.push(...growOnlyBreaks(`${subject} ${name}`, members(value), members(nextValue ?? "")));
      else if (RULES.has(name)) problems.push(...refusalListBreaks(`${subject} ${name}`, members(value), members(nextValue ?? "")));
      else if (name === "schema") {
        problems.push(...jsonSchemaBreakingChanges(JSON.parse(value), JSON.parse(nextValue ?? "{}"), "request").map((change) => `${subject} ${change}`));
      } else if (name === "max") {
        if (nextValue === undefined || Number(nextValue) < Number(value)) problems.push(`${subject} max: the limit tightened from ${value} to ${nextValue ?? "none"}.`);
      } else if (nextValue !== value) problems.push(`${subject} ${name}: the value changed from ${value} to ${nextValue ?? "none"}.`);
    }
    for (const name of next.attributes.keys()) {
      if (RULES.has(name) && !line.attributes.has(name)) problems.push(...refusalListBreaks(`${subject} ${name}`, [], members(next.attributes.get(name)!)));
    }
    for (const flag of line.flags) if (!RULE_FLAGS.has(flag) && !next.flags.has(flag)) problems.push(`${subject}: ${flag} was removed.`);
    for (const flag of next.flags) if (RULE_FLAGS.has(flag) && !line.flags.has(flag)) problems.push(`${subject}: ${flag} was added: a new refusal.`);
  }
  for (const [subject, line] of now) {
    if (line.kind === "order" && !was.has(subject)) problems.push(`${subject}: an ordering rule was added: a new refusal.`);
  }
  return problems;
}

/**
 * The reasons a theme save can give and the private pages' checker and policy
 * versions (`save-reasons.snapshot.json`): a new reason is a new refusal; a
 * new checker or policy version checks every stored private page again.
 * A reason that goes refuses less.
 */
export function saveReasonsBreakingChanges(before: unknown, after: unknown): string[] {
  const was = record(before);
  const now = record(after);
  const problems = refusalListBreaks("reasons", was.reasons ?? [], now.reasons ?? []);
  for (const key of ["checker", "policy"]) {
    if (was[key] !== now[key]) problems.push(`${key}: the version changed from ${String(was[key])} to ${String(now[key])}: every stored private page is checked again.`);
  }
  return problems;
}
