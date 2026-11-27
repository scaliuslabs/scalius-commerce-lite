// A theme for the account generated to sit just above every floor (the private pages' rendered gate): each box of the
// account painted, light and dark alternating between a box and the boxes it holds (a box that holds fields light), every
// button filled, and every
// colour token of every row (boxes, words, buttons, fields, their labels and rings) set to a colour that reads only just
// above ITS floor on the surface its row is checked on (words 4.5:1, a graphic's marks, a ring, a field's edge and a main
// action's fill 3:1). Each row starts a hair above its floor and moves away from it only while the save refuses that row,
// so one row's trouble never lifts another. Pixel rounding, blending and hover misses near the floor show in the browser
// where a comfortable theme hides them. The save's own check settles each value.
import {
  compilePrivateTokens,
  compileTabBarTokens,
  PRIVATE_TAB_BAR_DEFAULTS,
  PRIVATE_TAB_BAR_LABEL,
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
/** An ordinary button's fill (its words are what find it): a mid tone, so its words sit near their floor either way. */
const BUTTON_FILL = "#7b5cc4";
const CRITICAL_FILL = "#b4453a";

/** How far above its floor a row starts, and the steps it moves out while the save refuses it. */
export const NEAR_FLOOR_MARGINS = [1.02, 1.04, 1.07, 1.12, 1.2, 1.35, 1.6] as const;

/** The first colour on the line from a tinted mid tone toward black or white that reads at `floor` on every back, a hair above it. */
function justAbove(backs: readonly string[], floor: number, margin: number): string {
  const target = floor * margin;
  const worst = (colour: string) => Math.min(...backs.map((back) => storefrontThemeContrast(colour, back)));
  for (const end of ["#000000", "#ffffff"]) {
    for (let step = 0; step <= 400; step += 1) {
      const colour = storefrontThemeMix("#6f6a8c", end, step / 400);
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

export interface NearFloorTheme {
  tokens: Record<string, Record<string, unknown>>;
  /** Each row's margin over its floor when the save took it. */
  margins: Record<string, number>;
  /** Rows the save refused at the widest margin, left to the store's defaults (none expected). */
  dropped: string[];
}

export function nearFloorAccountTheme(context: PrivatePagesCompileContext): NearFloorTheme {
  const spec = PRIVATE_PAGES.account;
  const compile = (tokens: Record<string, Record<string, unknown>>) => compilePrivateTokens("account", tokens as never, { layout: spec.layout, items: {}, palettes: context.palettes });
  const save = (tokens: Record<string, Record<string, unknown>>) => compileStorefrontPrivatePages({ ...storefrontPrivatePagesDefault(), tokens: { account: tokens } } as never, context);
  // The boxes, light and dark alternating with depth; every button filled (a main action's fill is set near its floor below).
  const base: Record<string, Record<string, unknown>> = {};
  const first = compile({ page: { background: LIGHT } }).tables[0]!;
  const byKey = new Map(first.rows.map((row) => [row.key, row]));
  for (const row of first.rows) {
    const style = spec.styles[row.key];
    if (!style || row.kind !== "box" || !style.tokens.includes("background")) continue;
    // A box that holds fields is light: a field's label has one colour for every box it stands in, and no colour reads
    // 4.5:1 on both the light and the dark tone.
    base[row.key] = { background: style.fields || depthOf(row, byKey) % 2 === 0 ? LIGHT : DARK };
  }
  for (const [name, style] of Object.entries(spec.styles)) {
    if (style.kind !== "control" || !style.tokens.includes("background") || style.boundary) continue;
    if (style.surface === "primary") base[name] = { background: BUTTON_FILL };
    if (style.surface === "destructive") base[name] = { background: CRITICAL_FILL };
  }
  const step = new Map<string, number>(Object.keys(spec.styles).map((name) => [name, 0]));
  const dropped = new Set<string>();
  const valuesOf = (tokens: Record<string, Record<string, unknown>>) => {
    // Every palette a buyer sees: a value reads on its row's surfaces in each.
    const tables = compile(tokens).tables.map((table) => ({ table, rows: new Map(table.rows.map((row) => [row.key, row])) }));
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, style] of Object.entries(spec.styles)) {
      if (dropped.has(name)) continue;
      const own = tables.flatMap(({ table, rows }) => table.rows.filter((row) => row.key === name || row.key.startsWith(`${name}/`)).map((row) => ({ row, rows })));
      const values: Record<string, unknown> = { ...base[name] };
      if (own.length > 0) {
        const margin = NEAR_FLOOR_MARGINS[step.get(name)!]!;
        const surfaces = [...new Set(own.flatMap(({ row }) => row.surface))];
        const around = [...new Set(own.flatMap(({ row, rows }) => row.parents.flatMap((key) => rows.get(key)?.surface ?? [])))];
        const marked = style.kind === "control" || style.kind === "field";
        // A main action's fill just above 3:1 on what is around it, its words then just above 4.5:1 on that fill.
        const fill = style.boundary === "fill" && around.length > 0 ? justAbove(around, 3, margin) : null;
        if (fill) values.background = fill;
        const on = fill ? [fill] : surfaces;
        for (const token of ["text", "muted", "link", "error", "placeholder"] as const) if (style.tokens.includes(token)) values[token] = justAbove(on, style.graphic && (token === "text" || token === "muted") ? 3 : 4.5, margin);
        if (style.tokens.includes("ring")) values.ring = justAbove(marked && around.length > 0 ? around : surfaces, 3, margin);
        if (style.tokens.includes("invalid") && around.length > 0) values.invalid = justAbove(around, 3, margin);
        if (style.tokens.includes("border") && (style.kind === "field" || style.boundary === "edge") && around.length > 0) values.border = justAbove(around, 3, margin);
      }
      if (Object.keys(values).length > 0) out[name] = values;
    }
    return out;
  };
  // Settle: the base (the boxes' and buttons' fills) first, then the words on them; a refused row moves one step out.
  let tokens = valuesOf(base);
  for (let round = 0; round < 40; round += 1) {
    tokens = valuesOf(tokens);
    const saved = save(tokens);
    if (saved.ok) break;
    for (const name of new Set(saved.issues.map((issue) => String(issue.path[3] ?? "")).filter(Boolean))) {
      const key = name.split("/")[0]!;
      const next = (step.get(key) ?? 0) + 1;
      if (next < NEAR_FLOOR_MARGINS.length) step.set(key, next);
      else { dropped.add(key); delete base[key]; }
    }
  }
  if (!save(tokens).ok) throw new Error("the near-floor account theme does not save");
  const margins = Object.fromEntries([...step].filter(([name]) => name in tokens).map(([name, index]) => [name, NEAR_FLOOR_MARGINS[index]!]));
  return { tokens, margins, dropped: [...dropped] };
}

export function nearFloorAccountTokens(context: PrivatePagesCompileContext): Record<string, Record<string, unknown>> {
  return nearFloorAccountTheme(context).tokens;
}

/**
 * The phone tab bar's look just above every floor against the store's palettes (`tokens.tabBar`): the store's blurred
 * bar on its page colour, every tab's words and the current tab's at 4.5:1 on it at its lightest and darkest (the
 * current one 200 heavier, so its weight tells it apart), each icon at 3:1 on a chip, the cart count at 4.5:1 on a badge
 * that reads 3:1 on the bar, a 10px label (the bar's floor) and the bar exactly as tall as a tab needs. Each colour
 * starts a hair above its floor and moves out only while the save refuses it.
 */
export function nearFloorTabBarTokens(context: PrivatePagesCompileContext): Record<string, Record<string, unknown>> {
  const icon = 20;
  const padding = 6;
  const height = Math.ceil(icon + 2 * padding + PRIVATE_TAB_BAR_DEFAULTS.gap + 10 * (2 * PRIVATE_TAB_BAR_LABEL.leading + 2 * PRIVATE_TAB_BAR_LABEL.room));
  for (const margin of NEAR_FLOOR_MARGINS) {
    const scheme = (pick: (colors: (typeof context.palettes)[number]["colors"]) => string) => Object.fromEntries(context.palettes.map((palette) => [palette.scheme, pick(palette.colors)]));
    const under = (colors: (typeof context.palettes)[number]["colors"]) => [storefrontThemeMix(colors.background, "#ffffff", 0.06), storefrontThemeMix(colors.background, "#000000", 0.06)];
    const per = (values: Record<string, string>) => (context.palettes.length === 1 ? Object.values(values)[0]! : values);
    const label = scheme((colors) => justAbove(under(colors), 4.5, margin));
    const chipOf = (words: string) => justAbove([words], 3, margin);
    const badge = scheme((colors) => justAbove(under(colors), 3, margin));
    const tokens = {
      bar: { background: "background", height, backdrop: "blur" },
      label: { text: per(label), size: 10, weight: "500", clamp: "2" },
      icon: { size: icon, padding, radius: 4, background: per(Object.fromEntries(Object.entries(label).map(([key, words]) => [key, chipOf(words)]))) },
      current: { text: per(label), weight: "700", padding },
      badge: { background: per(badge), text: per(Object.fromEntries(Object.entries(badge).map(([key, fill]) => [key, justAbove([fill], 4.5, margin)]))) },
    };
    if (compileTabBarTokens(tokens as never, context.palettes).issues.length === 0) return tokens;
  }
  throw new Error("the near-floor tab bar does not save");
}
