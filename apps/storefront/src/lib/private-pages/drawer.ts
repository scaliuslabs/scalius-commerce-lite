/**
 * The drawer's plan as the page writes it (lib/cart/drawer-plan.ts): null
 * for a theme that leaves the drawer as the host draws it, so a default
 * page carries nothing. It names host parts and targets only.
 */
import { privatePagePlan } from "./plan";
import type { PrivateAssetUrl } from "./html";
import type { PrivateNode, StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { lineTargetPlace, type CartDrawerNode, type CartDrawerPlan } from "@/lib/cart/drawer-plan";

function drawerNodes(nodes: readonly PrivateNode[]): CartDrawerNode[] {
  return nodes.flatMap((node): CartDrawerNode[] => {
    if (node.type === "layout") return Array.isArray(node.children) ? [{ type: "layout", layout: node.layout, ...(node.hook ? { hook: node.hook } : {}), children: drawerNodes(node.children) }] : [];
    if (node.type === "part") return [{ type: "part", part: node.part }];
    return node.type === "target" ? [{ type: "target", target: node.target }] : [];
  });
}

export function cartDrawerPlan(theme: StorefrontThemeDocument, language: string, asset: PrivateAssetUrl): CartDrawerPlan | null {
  const plan = privatePagePlan(theme, "cartDrawer", language, asset);
  const line = plan.items.line;
  // The host's own line places its apps' block where the cart page's line does (the theme's arrangement of it, or the host's).
  const lineTarget = line ? null : lineTargetPlace(privatePagePlan(theme, "cart", language, asset).items.line);
  if (plan.frame === "standard" && !plan.layout && !line && !lineTarget && Object.keys(plan.labels).length === 0 && Object.keys(plan.icons).length === 0) return null;
  return {
    frame: plan.frame ?? "standard",
    layout: plan.layout ? drawerNodes(plan.layout) : null,
    line: line ? drawerNodes(line) : null,
    ...(lineTarget ? { lineTarget } : {}),
    labels: plan.labels,
    icons: plan.icons,
  };
}
