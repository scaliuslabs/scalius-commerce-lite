// A theme for the account generated to sit just above every floor (the private pages' rendered gate, review round 2,
// C6): each box of the account painted, light and dark alternating between a box and the boxes it holds, and every
// colour token of every row set to a colour that reads only just above its floor on the surface its row is checked on
// (words 4.5:1, a graphic's marks, a ring and a field's edge 3:1). Pixel rounding, blending and hover misses near the
// floor show in the browser where a comfortable theme hides them. The save's own check settles each value.
import {
  compilePrivateTokens,
  compileStorefrontPrivatePages,
  PRIVATE_PAGES,
  storefrontPrivatePagesDefault,
  storefrontThemeContrast,
  storefrontThemeMix,
  type PrivatePagesCompileContext,
  type PrivateTokenRow,
} from "@scalius/shared/storefront-theme";

const LIGHT = "#f5f3ee";
const DARK = "#232031";

/** The first colour on the line from a tinted mid tone toward black or white that reads at `floor` on every back, a hair above it. */
function justAbove(backs: readonly string[], floor: number, margin: number): string {
  const target = floor * margin;
  const worst = (colour: string) => Math.min(...backs.map((back) => storefrontThemeContrast(colour, back)));
  for (const end of ["#000000", "#ffffff"]) {
    for (let step = 0; step <= 200; step += 1) {
      const colour = storefrontThemeMix("#6f6a8c", end, step / 200);
      if (worst(colour) >= target) return colour;
    }
  }
  return worst("#000000") > worst("#ffffff") ? "#000000" : "#ffffff";
}

/** Each box's depth among the boxes: the boxes it stands in. */
function depthOf(row: PrivateTokenRow, byKey: Map<string, PrivateTokenRow>): number {
  let depth = 0;
  for (let parent = row.parents.length === 1 ? byKey.get(row.parents[0]!) : undefined; parent; parent = parent.parents.length === 1 ? byKey.get(parent.parents[0]!) : undefined) if (parent.kind === "box") depth += 1;
  return depth;
}

export function nearFloorAccountTokens(context: PrivatePagesCompileContext): Record<string, Record<string, unknown>> {
  const spec = PRIVATE_PAGES.account;
  const compile = (tokens: Record<string, Record<string, unknown>>) => compilePrivateTokens("account", tokens as never, { layout: spec.layout, items: {}, palettes: context.palettes });
  // The boxes, light and dark alternating with depth.
  const tokens: Record<string, Record<string, unknown>> = {};
  const first = compile({ page: { background: LIGHT } }).tables[0]!;
  const byKey = new Map(first.rows.map((row) => [row.key, row]));
  for (const row of first.rows) {
    const style = spec.styles[row.key];
    if (!style || row.kind !== "box" || !style.tokens.includes("background")) continue;
    tokens[row.key] = { background: depthOf(row, byKey) % 2 === 0 ? LIGHT : DARK };
  }
  // Every colour token of every row just above its floor on the surfaces it is checked on; a value the save refuses
  // moves further from its floor until it saves.
  for (const margin of [1.02, 1.06, 1.12, 1.25]) {
    const table = compile(tokens).tables[0]!;
    const rows = new Map(table.rows.map((row) => [row.key, row]));
    for (const [name, style] of Object.entries(spec.styles)) {
      const own = table.rows.filter((row) => row.key === name || row.key.startsWith(`${name}/`));
      if (own.length === 0) continue;
      const surfaces = [...new Set(own.flatMap((row) => row.surface))];
      const around = [...new Set(own.flatMap((row) => row.parents.flatMap((key) => rows.get(key)?.surface ?? [])))];
      const marked = style.kind === "control" || style.kind === "field";
      const values: Record<string, unknown> = { ...tokens[name] };
      for (const token of ["text", "muted", "link", "error", "placeholder"] as const) if (style.tokens.includes(token)) values[token] = justAbove(surfaces, style.graphic && (token === "text" || token === "muted") ? 3 : 4.5, margin);
      if (style.tokens.includes("ring")) values.ring = justAbove(marked && around.length > 0 ? around : surfaces, 3, margin);
      if (style.tokens.includes("invalid") && around.length > 0) values.invalid = justAbove(around, 3, margin);
      if (style.tokens.includes("border") && (style.kind === "field" || style.boundary === "edge") && around.length > 0) values.border = justAbove(around, 3, margin);
      tokens[name] = values;
    }
    const saved = compileStorefrontPrivatePages({ ...storefrontPrivatePagesDefault(), tokens: { account: tokens } } as never, context);
    if (saved.ok) return tokens;
  }
  // What still does not save at the widest margin is left to the store's defaults.
  const saved = compileStorefrontPrivatePages({ ...storefrontPrivatePagesDefault(), tokens: { account: tokens } } as never, context);
  if (!saved.ok) for (const issue of saved.issues) delete tokens[String(issue.path[3])];
  return tokens;
}
