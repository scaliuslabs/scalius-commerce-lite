// The compatibility rules a sealed table follows, as change lines a break
// ledger acknowledges (lock.ts). Three directions:
//
//   grow     what a theme or app names: a list keeps every member, an object
//            every key, at any depth; a value stays as it is. Growth is not
//            a break.
//   loosen   a limit an app is built against: a maximum, a budget or a size
//            only rises, a minimum only falls.
//   refuse   a list a check refuses by (the store's words): a member may go
//            (fewer refusals), never come; a new one refuses an app that
//            passes today, so it is a security change, never growth.
//   fixed    a set per key (which routes a private page key reaches): a new
//            key is growth, an existing key's set never gains or loses a member.

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => JSON.stringify(value);

/** Grow-only at every depth: the lines for each member, key or value `after` lost or changed. */
export function growOnlyBreaks(path: string, before: unknown, after: unknown): string[] {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return [`${path}: the list was removed or retyped.`];
    const scalars = before.every((value) => !isObject(value) && !Array.isArray(value));
    if (scalars) {
      const kept = new Set(after.map(text));
      return before.filter((value) => !kept.has(text(value))).map((value) => `${path}: ${text(value)} was removed.`);
    }
    return before.flatMap((value, index) => index < after.length ? growOnlyBreaks(`${path}[${index}]`, value, after[index]) : [`${path}[${index}]: the entry was removed.`]);
  }
  if (isObject(before)) {
    if (!isObject(after)) return [`${path}: the table was removed or retyped.`];
    return Object.entries(before).flatMap(([key, value]) => key in after ? growOnlyBreaks(`${path}.${key}`, value, after[key]) : [`${path}.${key}: the key was removed.`]);
  }
  return text(before) === text(after) ? [] : [`${path}: the value changed from ${text(before)} to ${text(after)}.`];
}

/** One limit an app is built against: its value and the way it may move. */
export interface SealedLimit {
  value: number | null;
  /** `up`: a maximum, budget or size (only rises); `down`: a minimum (only falls). */
  loosens: "up" | "down";
}

/** Loosen-only: each limit keeps its direction and moves only that way (null is no limit at all). */
export function loosenOnlyBreaks(path: string, before: Readonly<Record<string, SealedLimit>>, after: Readonly<Record<string, SealedLimit>>): string[] {
  return Object.entries(before).flatMap(([name, was]) => {
    const now = after[name];
    if (!now) return [`${path}.${name}: the limit was removed from the seal.`];
    if (now.loosens !== was.loosens) return [`${path}.${name}: the limit's direction changed from ${was.loosens} to ${now.loosens}.`];
    if (now.value === null) return was.loosens === "up" ? [] : [`${path}.${name}: the limit tightened from ${text(was.value)} to no minimum.`];
    if (was.value === null) return [`${path}.${name}: the limit tightened from none to ${now.value}.`];
    const tighter = was.loosens === "up" ? now.value < was.value : now.value > was.value;
    return tighter ? [`${path}.${name}: the limit tightened from ${was.value} to ${now.value}.`] : [];
  });
}

/** Refuse lists: the members `after` gained, each a new refusal. Removing a member refuses less, which breaks nothing. */
export function refusalListBreaks(path: string, before: unknown, after: unknown): string[] {
  if (Array.isArray(after)) {
    const had = new Set((Array.isArray(before) ? before : []).map(text));
    return after.filter((value) => !had.has(text(value))).map((value) => `${path}: ${text(value)} was added: a new refusal.`);
  }
  if (isObject(after)) {
    const was = isObject(before) ? before : {};
    return Object.entries(after).flatMap(([key, value]) => key in was ? refusalListBreaks(`${path}.${key}`, was[key], value) : [`${path}.${key}: ${text(value)} was added: a new refusal.`]);
  }
  return text(before) === text(after) ? [] : [`${path}: the value changed from ${text(before)} to ${text(after)}: a new refusal.`];
}

/** Fixed per key: a key may be added; an existing key keeps exactly its set (order aside). */
export function fixedPerKeyBreaks(path: string, before: unknown, after: unknown): string[] {
  const was = isObject(before) ? before : {};
  const now = isObject(after) ? after : {};
  const set = (value: unknown) => (Array.isArray(value) ? [...value].map(text).sort() : [text(value)]);
  return Object.entries(was).flatMap(([key, value]) => {
    if (!(key in now)) return [`${path}.${key}: the key was removed.`];
    const before = set(value);
    const after = set(now[key]);
    return before.join(",") === after.join(",") ? [] : [`${path}.${key}: the set changed from [${before.join(", ")}] to [${after.join(", ")}].`];
  });
}
