// The rule of the numbers a stored theme is read against (storefront-theme/read-bounds.test.ts seals
// `read-bounds.snapshot.json` with it): a maximum never falls, a minimum never rises, and a field that
// had bounds never gains a new one (a tightening). A bound may rise or go, and a field the read did not
// have before brings its bounds freely. Imports nothing: the contract lock's judge loads it with Node.

interface Bound {
  kind: "max" | "min";
  value: number;
}

/** The field a bound's key names (`$.pages.home[].x max_length` → `$.pages.home[].x`; a refinement is its own field). */
const fieldOf = (key: string) => (key.startsWith("refine: ") ? key : key.replace(/ [a-z_]+$/, ""));

export function readBoundsBreakingChanges(before: unknown, after: unknown): string[] {
  const released = (before ?? {}) as Record<string, Bound>;
  const now = (after ?? {}) as Record<string, Bound>;
  const fields = new Set(Object.keys(released).map(fieldOf));
  return Object.entries(now).flatMap(([key, bound]) => {
    const was = released[key];
    if (!was) return fields.has(fieldOf(key)) ? [`${key}: a new ${bound.kind} of ${bound.value} on a field read before: tightened.`] : [];
    if (was.kind !== bound.kind) return [`${key}: the bound changed from a ${was.kind} to a ${bound.kind}: tightened.`];
    if (bound.kind === "max" && bound.value < was.value) return [`${key}: the max tightened from ${was.value} to ${bound.value}.`];
    if (bound.kind === "min" && bound.value > was.value) return [`${key}: the min tightened from ${was.value} to ${bound.value}.`];
    return [];
  });
}
