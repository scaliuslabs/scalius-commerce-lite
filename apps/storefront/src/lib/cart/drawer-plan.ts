// The cart drawer's arrangement (private-anatomy.ts, page `cartDrawer`). The
// drawer mounts in the browser after the page, so the Layout writes what the
// theme set as JSON (`#cartDrawerPlan`), only where it is not the default:
// the frame, the layout of the drawer and of its line (host parts, targets
// and layouts only), and its words and icons in the page's language. No
// plan: the drawer as every store drew it.

/** One node of the drawer's plan: a host layout, a part or a target. */
export type CartDrawerNode =
  | { type: "layout"; layout: string; hook?: string; children: CartDrawerNode[] }
  | { type: "part"; part: string }
  | { type: "target"; target: string };

export interface CartDrawerPlan {
  frame: string;
  /** Null: the host's own drawer. */
  layout: CartDrawerNode[] | null;
  /** Null: the host's own line. */
  line: CartDrawerNode[] | null;
  /**
   * Where the host's own line draws its apps' block (`cart.line.after`): `below`, under the line's other parts
   * at its full width, where the theme's cart page line puts it (`lineTargetPlace`); absent, in the line's text column
   * as the cart page's own line does. A drawer line the theme arranges itself (`line`) places it where it says.
   */
  lineTarget?: "below";
  labels: Record<string, string>;
  icons: Record<string, string>;
}

export const CART_DRAWER_PLAN_ID = "cartDrawerPlan";

const DEFAULT_PLAN: CartDrawerPlan = { frame: "standard", layout: null, line: null, labels: {}, icons: {} };

type LineNode = { type: string; part?: string; target?: string; layout?: string; children?: readonly LineNode[] };

/** The branch of `nodes` (its index) holding what `match` finds, at any depth. */
function branchOf(nodes: readonly LineNode[], match: (node: LineNode) => boolean): number {
  return nodes.findIndex(function holds(node: LineNode): boolean {
    return match(node) || (node.type === "layout" && (node.children ?? []).some(holds));
  });
}

/**
 * Where a line arrangement draws its apps' block (`cart.line.after`), the one rule the cart page's line and the
 * drawer's own line share: `below` when, where the block's branch and the image's part ways, they stack (the line's
 * root, a `stack` or a `group`) and the block comes after the image, so it spans the line under the image's row; else
 * null (beside the image, in a `columns` or `grid` next to it, or a line with no image): in the text column.
 */
export function lineTargetPlace(line: readonly LineNode[] | null | undefined): "below" | null {
  const isTarget = (node: LineNode) => node.type === "target" && node.target === "cart.line.after";
  const isImage = (node: LineNode) => node.type === "part" && node.part === "image";
  let nodes: readonly LineNode[] = line ?? [];
  let kind = "root";
  for (;;) {
    const [target, image] = [branchOf(nodes, isTarget), branchOf(nodes, isImage)];
    if (target < 0 || image < 0) return null;
    if (target !== image) return ["root", "stack", "group"].includes(kind) && target > image ? "below" : null;
    const shared = nodes[target]!;
    if (shared.type !== "layout") return null;
    kind = shared.layout ?? "group";
    nodes = shared.children ?? [];
  }
}

/** The page's drawer plan; the default when it wrote none or it does not read. */
export function readCartDrawerPlan(doc: Document | null = typeof document === "undefined" ? null : document): CartDrawerPlan {
  const text = doc?.querySelector(`script[type="application/json"]#${CART_DRAWER_PLAN_ID}`)?.textContent;
  if (!text) return DEFAULT_PLAN;
  try {
    return { ...DEFAULT_PLAN, ...(JSON.parse(text) as Partial<CartDrawerPlan>) };
  } catch {
    return DEFAULT_PLAN;
  }
}
