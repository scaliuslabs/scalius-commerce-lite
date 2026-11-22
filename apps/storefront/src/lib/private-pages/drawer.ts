/**
 * The drawer's plan as the page writes it (lib/cart/drawer-plan.ts): null
 * for a theme that leaves the drawer as the host draws it, so a default
 * page carries nothing. The theme's content blocks are drawn here, on the
 * server, as escaped HTML: the drawer's script carries no renderer for them.
 */
import { privatePagePlan } from "./plan";
import { privateContentHtml, type PrivateAssetUrl } from "./html";
import type { PrivateNode, StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import type { CartDrawerNode, CartDrawerPlan } from "@/lib/cart/drawer-plan";

function drawerNodes(nodes: readonly PrivateNode[], language: string, asset: PrivateAssetUrl): CartDrawerNode[] {
  return nodes.flatMap((node): CartDrawerNode[] => {
    if (node.type === "layout") return [{ type: "layout", layout: node.layout, ...(node.hook ? { hook: node.hook } : {}), children: drawerNodes(node.children, language, asset) }];
    if (node.type === "content") {
      const html = privateContentHtml(node.content, node.hook, language, asset);
      return html ? [{ type: "html", html }] : [];
    }
    return node.type === "part" ? [{ type: "part", part: node.part }] : [{ type: "target", target: node.target }];
  });
}

export function cartDrawerPlan(theme: StorefrontThemeDocument, language: string, asset: PrivateAssetUrl): CartDrawerPlan | null {
  const plan = privatePagePlan(theme, "cartDrawer", language, asset);
  const line = plan.items.line;
  if (plan.frame === "standard" && !plan.layout && !line && Object.keys(plan.labels).length === 0 && Object.keys(plan.icons).length === 0) return null;
  return {
    frame: plan.frame ?? "standard",
    layout: plan.layout ? drawerNodes(plan.layout, language, asset) : null,
    line: line ? drawerNodes(line, language, asset) : null,
    labels: plan.labels,
    icons: plan.icons,
  };
}
