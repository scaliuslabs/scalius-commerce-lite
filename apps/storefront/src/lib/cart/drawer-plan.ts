// The cart drawer's arrangement (private-anatomy.ts, page `cartDrawer`). The
// drawer mounts in the browser after the page, so the Layout writes what the
// theme set as JSON (`#cartDrawerPlan`), only where it is not the default:
// the frame, the layout of the drawer and of its line (the theme's content
// blocks already drawn as escaped HTML on the server), and its words and
// icons in the page's language. No plan: the drawer as every store drew it.

/** One node of the drawer's plan: a host layout, a part, a target, or the theme's content as HTML. */
export type CartDrawerNode =
  | { type: "layout"; layout: string; hook?: string; children: CartDrawerNode[] }
  | { type: "part"; part: string }
  | { type: "target"; target: string }
  | { type: "html"; html: string };

export interface CartDrawerPlan {
  frame: string;
  /** Null: the host's own drawer. */
  layout: CartDrawerNode[] | null;
  /** Null: the host's own line. */
  line: CartDrawerNode[] | null;
  labels: Record<string, string>;
  icons: Record<string, string>;
}

export const CART_DRAWER_PLAN_ID = "cartDrawerPlan";

const DEFAULT_PLAN: CartDrawerPlan = { frame: "standard", layout: null, line: null, labels: {}, icons: {} };

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
