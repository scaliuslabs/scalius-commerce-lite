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
   * as the cart page's own line does. The drawer's line follows the cart page's, so the two never place it apart.
   */
  lineTarget?: "below";
  labels: Record<string, string>;
  icons: Record<string, string>;
}

export const CART_DRAWER_PLAN_ID = "cartDrawerPlan";

const DEFAULT_PLAN: CartDrawerPlan = { frame: "standard", layout: null, line: null, labels: {}, icons: {} };

/**
 * Where a line arrangement puts its apps' block: `below` when the target is one of the line's own nodes (drawn
 * under the rest at the line's full width), else null (inside a layout of the line, beside the image).
 */
export function lineTargetPlace(line: readonly { type: string; target?: string }[] | null | undefined): "below" | null {
  return line?.some((node) => node.type === "target" && node.target === "cart.line.after") ? "below" : null;
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
