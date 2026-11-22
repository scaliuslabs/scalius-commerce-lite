// A private page's arrangement (private-anatomy.ts): its frame, its layout
// tree and the layout of each repeated unit. Absent parts of an arrangement
// are the host's default (an absent `layout` draws today's page).
//
// Three readings, one rule set:
// - `privateArrangementIssues`: the strict check a save and a publish run.
//   Every mandatory part and every target exactly once, no unknown name,
//   no duplicate, only the layouts the unit takes; each problem with a
//   machine-readable `reason`.
// - `fillPrivateArrangement`: what a read of an arrangement stored before
//   this build does. Unknown and duplicate names go; a mandatory part or
//   target it lacks (core added one since) goes in its default place. A
//   core upgrade never breaks a stored theme and never loses a required part.
// - `privateArrangementIsDefault`: an arrangement equal to the default draws
//   the page exactly as the host does without one.
//
// Data only, no zod: the dashboard and the storefront's browser code read it.
import {
  PRIVATE_HOOK_MAX,
  PRIVATE_HOOK_PATTERN,
  PRIVATE_PAGES,
  type PrivateLayoutKind,
  type PrivateNode,
  type PrivatePageKey,
  type PrivatePageSpec,
  type PrivateUnitSpec,
} from "./private-anatomy";

/** One page's arrangement as the theme document stores it. */
export interface PrivatePageArrangement {
  /** The page frame's variant (absent: the default). */
  frame?: string;
  /** The page's layout (absent: the default). */
  layout?: PrivateNode[];
  /** Each repeated unit's layout (absent: the default). */
  items?: Record<string, PrivateNode[]>;
}

/** Bounds of one unit's layout. */
export const PRIVATE_ARRANGEMENT_LIMITS = { depth: 6, nodes: 80, children: 24 } as const;

/** Why an arrangement is refused. */
export const PRIVATE_ARRANGEMENT_REASONS = [
  "missing_part", "duplicate_part", "unknown_part",
  "missing_target", "duplicate_target", "unknown_target",
  "unknown_layout", "layout_once", "unknown_variant", "unknown_frame", "unknown_item", "invalid_hook",
  "too_deep", "too_many_nodes",
] as const;
export type PrivateArrangementReason = (typeof PRIVATE_ARRANGEMENT_REASONS)[number];

export interface PrivateArrangementIssue {
  /** From the page's arrangement: `["layout", 2, "children", 0]`, `["items", "line", 1]`. */
  path: Array<string | number>;
  reason: PrivateArrangementReason;
  message: string;
}

/** Layouts a unit may hold only once (the cart's phone fold, the drawer's scroll region). */
const SINGLE_LAYOUTS: ReadonlySet<PrivateLayoutKind> = new Set(["fold", "scroll"]);

function unitIssues(spec: PrivateUnitSpec, nodes: readonly PrivateNode[], base: Array<string | number>, what: string): PrivateArrangementIssue[] {
  const issues: PrivateArrangementIssue[] = [];
  const parts = new Map<string, number>();
  const targets = new Map<string, number>();
  const singles = new Set<PrivateLayoutKind>();
  let count = 0;
  const visit = (list: readonly PrivateNode[], path: Array<string | number>, depth: number) => {
    if (list.length > PRIVATE_ARRANGEMENT_LIMITS.children) {
      issues.push({ path, reason: "too_many_nodes", message: `A layout holds at most ${PRIVATE_ARRANGEMENT_LIMITS.children} nodes.` });
    }
    list.forEach((node, index) => {
      const at = [...path, index];
      count += 1;
      if (node.type === "layout") {
        if (depth >= PRIVATE_ARRANGEMENT_LIMITS.depth) {
          issues.push({ path: at, reason: "too_deep", message: `Layouts nest at most ${PRIVATE_ARRANGEMENT_LIMITS.depth} deep.` });
          return;
        }
        if (!spec.layouts.includes(node.layout)) {
          issues.push({ path: [...at, "layout"], reason: "unknown_layout", message: `${what} takes the layouts ${spec.layouts.join(", ")}, not ${node.layout}.` });
        } else if (SINGLE_LAYOUTS.has(node.layout)) {
          if (singles.has(node.layout)) issues.push({ path: [...at, "layout"], reason: "layout_once", message: `${what} holds one ${node.layout} layout.` });
          singles.add(node.layout);
        }
        if (node.hook !== undefined && !validHook(node.hook)) issues.push({ path: [...at, "hook"], reason: "invalid_hook", message: hookMessage });
        visit(node.children, [...at, "children"], depth + 1);
      } else if (node.type === "part") {
        const entry = Object.hasOwn(spec.parts, node.part) ? spec.parts[node.part] : undefined;
        if (!entry) {
          issues.push({ path: [...at, "part"], reason: "unknown_part", message: `${what} has no part named ${node.part}; its parts are ${Object.keys(spec.parts).join(", ")}.` });
          return;
        }
        if (parts.has(node.part)) issues.push({ path: [...at, "part"], reason: "duplicate_part", message: `The ${node.part} part appears once.` });
        parts.set(node.part, index);
        if (node.variant !== undefined && !entry.variants?.includes(node.variant)) {
          issues.push({ path: [...at, "variant"], reason: "unknown_variant", message: entry.variants ? `The ${node.part} part's variants are ${entry.variants.join(", ")}.` : `The ${node.part} part has no variants.` });
        }
      } else if (node.type === "target") {
        if (!spec.targets.includes(node.target)) {
          issues.push({ path: [...at, "target"], reason: "unknown_target", message: `${what} has the extension targets ${spec.targets.join(", ") || "(none)"}, not ${node.target}.` });
          return;
        }
        if (targets.has(node.target)) issues.push({ path: [...at, "target"], reason: "duplicate_target", message: `The ${node.target} target appears once.` });
        targets.set(node.target, index);
      } else if (node.hook !== undefined && !validHook(node.hook)) {
        issues.push({ path: [...at, "hook"], reason: "invalid_hook", message: hookMessage });
      }
    });
  };
  visit(nodes, base, 0);
  if (count > PRIVATE_ARRANGEMENT_LIMITS.nodes) {
    issues.push({ path: base, reason: "too_many_nodes", message: `${what} holds at most ${PRIVATE_ARRANGEMENT_LIMITS.nodes} nodes.` });
  }
  for (const [name, entry] of Object.entries(spec.parts)) {
    if (entry.mandatory && !parts.has(name)) {
      issues.push({ path: base, reason: "missing_part", message: `${what} must show the ${name} part: a buyer needs it. Only ${optionalParts(spec).join(", ") || "no part"} may be left out.` });
    }
  }
  for (const target of spec.targets) {
    if (!targets.has(target)) issues.push({ path: base, reason: "missing_target", message: `${what} must place the ${target} target, where apps draw for the buyer.` });
  }
  return issues;
}

const hookMessage = `A hook is lowercase words joined by hyphens (studio-summary), at most ${PRIVATE_HOOK_MAX} characters.`;

function validHook(hook: string): boolean {
  return hook.length <= PRIVATE_HOOK_MAX && PRIVATE_HOOK_PATTERN.test(hook);
}

function optionalParts(spec: PrivateUnitSpec): string[] {
  return Object.entries(spec.parts).filter(([, entry]) => !entry.mandatory).map(([name]) => name);
}

/** Everything wrong with a page's arrangement (empty: it saves). */
export function privateArrangementIssues(page: PrivatePageKey, arrangement: PrivatePageArrangement): PrivateArrangementIssue[] {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const issues: PrivateArrangementIssue[] = [];
  if (arrangement.frame !== undefined && !spec.frames?.includes(arrangement.frame)) {
    issues.push({ path: ["frame"], reason: "unknown_frame", message: spec.frames ? `The ${page} page's frames are ${spec.frames.join(", ")}.` : `The ${page} page has no frames.` });
  }
  if (arrangement.layout) issues.push(...unitIssues(spec, arrangement.layout, ["layout"], `The ${page} page`));
  for (const [name, layout] of Object.entries(arrangement.items ?? {})) {
    const item = Object.hasOwn(spec.items, name) ? spec.items[name] : undefined;
    if (!item) {
      issues.push({ path: ["items", name], reason: "unknown_item", message: `The ${page} page repeats ${Object.keys(spec.items).join(", ") || "nothing"}, not ${name}.` });
      continue;
    }
    issues.push(...unitIssues(item, layout, ["items", name], `The ${page} page's ${name}`));
  }
  return issues;
}

// ─── Reading a stored arrangement ─────────────────────────────────────────

type Leaf = Extract<PrivateNode, { type: "part" | "target" }>;
const leafKey = (node: PrivateNode): string | null => node.type === "part" ? `part:${node.part}` : node.type === "target" ? `target:${node.target}` : null;

/** The default layout's leaves (parts and targets) in reading order. */
function defaultLeaves(nodes: readonly PrivateNode[]): Leaf[] {
  return nodes.flatMap((node) => node.type === "layout" ? defaultLeaves(node.children) : node.type === "part" || node.type === "target" ? [node] : []);
}

/** A unit's layout with unknown and repeated names dropped, and missing mandatory parts and targets at their default place. */
function fillUnit(spec: PrivateUnitSpec, nodes: readonly PrivateNode[]): PrivateNode[] {
  const seen = new Set<string>();
  const keep = (list: readonly PrivateNode[], depth: number): PrivateNode[] => list.flatMap((node): PrivateNode[] => {
    if (node.type === "layout") {
      if (depth >= PRIVATE_ARRANGEMENT_LIMITS.depth || !spec.layouts.includes(node.layout)) return [];
      return [{ ...node, children: keep(node.children, depth + 1) }];
    }
    if (node.type === "content") return [node];
    const key = leafKey(node)!;
    const known = node.type === "part" ? Object.hasOwn(spec.parts, node.part) : spec.targets.includes(node.target);
    if (!known || seen.has(key)) return [];
    seen.add(key);
    return [node.type === "part" && node.variant !== undefined && !spec.parts[node.part]!.variants?.includes(node.variant) ? { type: "part", part: node.part } : node];
  });
  const result = keep(nodes, 0);
  const order = defaultLeaves(spec.layout);
  const required = order.filter((leaf) => leaf.type === "target" || spec.parts[leaf.part]?.mandatory);
  for (const leaf of required) {
    const key = leafKey(leaf)!;
    if (seen.has(key)) continue;
    insertNear(result, order, order.indexOf(leaf), seen);
    seen.add(key);
  }
  return result;
}

/** Puts `order[index]` after the nearest default predecessor the layout holds, else before the nearest successor, else last. */
function insertNear(nodes: PrivateNode[], order: readonly Leaf[], index: number, present: ReadonlySet<string>): void {
  const leaf = order[index]!;
  const locate = (key: string, list: PrivateNode[]): { list: PrivateNode[]; at: number } | null => {
    for (let at = 0; at < list.length; at += 1) {
      const node = list[at]!;
      if (leafKey(node) === key) return { list, at };
      if (node.type === "layout") {
        const found = locate(key, node.children as PrivateNode[]);
        if (found) return found;
      }
    }
    return null;
  };
  for (let before = index - 1; before >= 0; before -= 1) {
    const key = leafKey(order[before]!)!;
    if (!present.has(key)) continue;
    const found = locate(key, nodes);
    if (found) return void found.list.splice(found.at + 1, 0, leaf);
  }
  for (let after = index + 1; after < order.length; after += 1) {
    const key = leafKey(order[after]!)!;
    if (!present.has(key)) continue;
    const found = locate(key, nodes);
    if (found) return void found.list.splice(found.at, 0, leaf);
  }
  nodes.push(leaf);
}

/**
 * A stored arrangement as this build draws it: unknown frames, layouts,
 * variants and names dropped, and each mandatory part or target a later
 * core added put in its default place. A current, valid one is returned as it is.
 */
export function fillPrivateArrangement(page: PrivatePageKey, arrangement: PrivatePageArrangement): PrivatePageArrangement {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const filled: PrivatePageArrangement = {};
  if (arrangement.frame !== undefined && spec.frames?.includes(arrangement.frame)) filled.frame = arrangement.frame;
  if (arrangement.layout) filled.layout = fillUnit(spec, arrangement.layout);
  const items = Object.entries(arrangement.items ?? {}).flatMap(([name, layout]) => Object.hasOwn(spec.items, name) ? [[name, fillUnit(spec.items[name]!, layout)] as const] : []);
  if (items.length > 0) filled.items = Object.fromEntries(items);
  return filled;
}

// ─── The default ──────────────────────────────────────────────────────────

function sameNodes(left: readonly PrivateNode[], right: readonly PrivateNode[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** True when the page's layout (absent or equal to the default) draws as the host draws it. */
export function privateLayoutIsDefault(page: PrivatePageKey, arrangement: PrivatePageArrangement | undefined): boolean {
  return !arrangement?.layout || sameNodes(arrangement.layout, PRIVATE_PAGES[page].layout);
}

/** True when a unit's layout (absent or equal to the default) draws as the host draws it. */
export function privateItemIsDefault(page: PrivatePageKey, item: string, arrangement: PrivatePageArrangement | undefined): boolean {
  const layout = arrangement?.items?.[item];
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  return !layout || !Object.hasOwn(spec.items, item) || sameNodes(layout, spec.items[item]!.layout);
}

/** The page's frame (its default when the arrangement names none). */
export function privateFrame(page: PrivatePageKey, arrangement: PrivatePageArrangement | undefined): string | undefined {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  return arrangement?.frame ?? spec.frames?.[0];
}

/** True when the whole arrangement draws the page as the host does without one. */
export function privateArrangementIsDefault(page: PrivatePageKey, arrangement: PrivatePageArrangement | undefined): boolean {
  if (!arrangement) return true;
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  return (arrangement.frame === undefined || arrangement.frame === spec.frames?.[0])
    && privateLayoutIsDefault(page, arrangement)
    && Object.keys(spec.items).every((item) => privateItemIsDefault(page, item, arrangement));
}

/** The arrangement in its shortest form: default frame, layout and items left out (undefined when all are). */
export function compactPrivateArrangement(page: PrivatePageKey, arrangement: PrivatePageArrangement | undefined): PrivatePageArrangement | undefined {
  if (!arrangement) return undefined;
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const compact: PrivatePageArrangement = {};
  if (arrangement.frame !== undefined && arrangement.frame !== spec.frames?.[0]) compact.frame = arrangement.frame;
  if (!privateLayoutIsDefault(page, arrangement)) compact.layout = arrangement.layout;
  const items = Object.entries(arrangement.items ?? {}).filter(([name]) => !privateItemIsDefault(page, name, arrangement));
  if (items.length > 0) compact.items = Object.fromEntries(items);
  return Object.keys(compact).length > 0 ? compact : undefined;
}

/** A unit's layout without one optional part (the default layout when none is given). */
export function privateLayoutWithout(nodes: readonly PrivateNode[], part: string): PrivateNode[] {
  return nodes.flatMap((node): PrivateNode[] => {
    if (node.type === "part" && node.part === part) return [];
    return node.type === "layout" ? [{ ...node, children: privateLayoutWithout(node.children, part) }] : [node];
  });
}

/** True when the layout holds the part. */
export function privateLayoutHas(nodes: readonly PrivateNode[], part: string): boolean {
  return nodes.some((node) => (node.type === "part" && node.part === part) || (node.type === "layout" && privateLayoutHas(node.children, part)));
}

// ─── The dashboard's presets ──────────────────────────────────────────────

/** The cart page's two ready-made arrangements: the cart beside the form on wide screens, or above it in one column. */
export const PRIVATE_CART_PRESETS = ["side", "top"] as const;
export type PrivateCartPreset = (typeof PRIVATE_CART_PRESETS)[number];

/** The cart above the details form in one narrow column (the old `summary: top`). */
export function privateCartTopArrangement(): PrivatePageArrangement {
  const [progress, notices, columns] = PRIVATE_PAGES.cart.layout;
  const children = (columns as Extract<PrivateNode, { type: "layout" }>).children;
  return { frame: "narrow", layout: structuredClone([progress!, notices!, { type: "layout", layout: "stack", children: [...children] }]) as PrivateNode[] };
}

/** The cart page's preset an arrangement is, or `custom`. */
export function privateCartPreset(arrangement: PrivatePageArrangement | undefined): PrivateCartPreset | "custom" {
  if (privateArrangementIsDefault("cart", arrangement)) return "side";
  const top = privateCartTopArrangement();
  return arrangement !== undefined && arrangement.frame === top.frame && sameNodes(arrangement.layout ?? [], top.layout!) && privateItemIsDefault("cart", "line", arrangement) ? "top" : "custom";
}

/** The arrangement of a cart preset (undefined: the default). */
export function privateCartPresetArrangement(preset: PrivateCartPreset): PrivatePageArrangement | undefined {
  return preset === "top" ? privateCartTopArrangement() : undefined;
}

/** The drawer's width and whether it suggests products, read from its arrangement. */
export function privateDrawerChoices(arrangement: PrivatePageArrangement | undefined): { width: "standard" | "wide"; recommendations: boolean } {
  return {
    width: privateFrame("cartDrawer", arrangement) === "wide" ? "wide" : "standard",
    recommendations: privateLayoutHas(arrangement?.layout ?? PRIVATE_PAGES.cartDrawer.layout, "recommendations"),
  };
}

/** The drawer's arrangement with its width or its suggestions changed, the rest kept. */
export function privateDrawerWith(arrangement: PrivatePageArrangement | undefined, change: { width?: "standard" | "wide"; recommendations?: boolean }): PrivatePageArrangement | undefined {
  const next: PrivatePageArrangement = structuredClone(arrangement ?? {});
  if (change.width !== undefined) next.frame = change.width;
  if (change.recommendations !== undefined) {
    const layout = next.layout ?? structuredClone(PRIVATE_PAGES.cartDrawer.layout) as PrivateNode[];
    const has = privateLayoutHas(layout, "recommendations");
    if (!change.recommendations) next.layout = privateLayoutWithout(layout, "recommendations");
    else if (!has) next.layout = fillWithOptional("cartDrawer", layout, "recommendations");
  }
  return compactPrivateArrangement("cartDrawer", next);
}

/** The layout with an optional part put back in its default place. */
function fillWithOptional(page: PrivatePageKey, nodes: PrivateNode[], part: string): PrivateNode[] {
  const spec: PrivatePageSpec = PRIVATE_PAGES[page];
  const order = defaultLeaves(spec.layout);
  const present = new Set(order.map(leafKey).filter((key): key is string => key !== null && privateLayoutHasKey(nodes, key)));
  const result = structuredClone(nodes) as PrivateNode[];
  insertNear(result, order, order.findIndex((leaf) => leaf.type === "part" && leaf.part === part), present);
  return result;
}

function privateLayoutHasKey(nodes: readonly PrivateNode[], key: string): boolean {
  return nodes.some((node) => leafKey(node) === key || (node.type === "layout" && privateLayoutHasKey(node.children, key)));
}
