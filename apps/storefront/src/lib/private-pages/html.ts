/**
 * A private page's arrangement as HTML (packages/plugin-sdk/docs/private-pages.md):
 * the host's layout nodes, its parts (the page's own markup, by name) and the
 * apps' extension targets, in the order the arrangement gives. Server-side
 * only: a page renders it once, from the stored arrangement, with no read of
 * its own. It writes host markup only: any other node draws nothing, whatever
 * a stored document holds; every hook is checked on save and escaped here.
 */
import { escapeHtml } from "@scalius/shared/html-escape";
import { storefrontExtensionBase } from "@scalius/shared/plugins/storefront-protocol";
import {
  PRIVATE_HOOK_ATTRIBUTE,
  type PrivateAssetRef,
  type PrivateLayoutKind,
  type PrivateNode,
} from "@scalius/shared/storefront-theme";

/** What draws each kind of node. */
export interface PrivateNodeRenderers {
  part(name: string, variant: string | undefined): string;
  target(name: string): string;
  /** A layout the page draws itself (the cart's fold, the drawer's scroll region); null: the host's plain box. */
  layout?(kind: PrivateLayoutKind, inner: string, hook: string | undefined): string | null;
}

/**
 * The plain layouts' classes. Each layout node is a size container and
 * `columns` splits by the width of the box it sits in (from 48rem), never
 * the viewport's: a narrow frame or a nested layout never squeezes a part.
 * A theme shapes `grid` (and overrides the rest) through its hook's tokens.
 */
export const PRIVATE_LAYOUT_CLASSES: Record<PrivateLayoutKind, string> = {
  stack: "@container flex min-w-0 flex-col gap-4",
  columns: "@container grid min-w-0 gap-4 @3xl:grid-flow-col @3xl:auto-cols-fr @3xl:gap-8",
  grid: "@container grid min-w-0 gap-4",
  group: "@container min-w-0",
  fold: "@container min-w-0",
  scroll: "@container min-w-0",
};

export function hookAttribute(hook: string | undefined): string {
  return hook ? ` ${PRIVATE_HOOK_ATTRIBUTE}="${escapeHtml(hook)}"` : "";
}

/** A host layout node: its kind on `data-layout`, the theme's hook on `data-hook`. */
export function layoutBox(kind: PrivateLayoutKind, inner: string, hook: string | undefined): string {
  return `<div data-layout="${kind}"${hookAttribute(hook)} class="${PRIVATE_LAYOUT_CLASSES[kind]}">${inner}</div>`;
}

/** The nodes in order, each drawn by its renderer; a node of any other type (none parses) draws nothing. */
export function renderPrivateNodes(nodes: readonly PrivateNode[], renderers: PrivateNodeRenderers): string {
  return nodes.map((node) => {
    if (node.type === "part") return renderers.part(node.part, node.variant);
    if (node.type === "target") return renderers.target(node.target);
    if (node.type !== "layout" || !Array.isArray(node.children)) return "";
    const inner = renderPrivateNodes(node.children, renderers);
    return renderers.layout?.(node.layout, inner, node.hook) ?? layoutBox(node.layout, inner, node.hook);
  }).join("");
}

/** The URL of a file of the theme's app (an icon's image), when that app is active (its release names the path); else null. */
export type PrivateAssetUrl = (ref: PrivateAssetRef) => string | null;

/** The URL resolver over the store's active apps (`readStorefrontExtensions`): their releases, no code. */
export function privateAssetUrls(extensions: ReadonlyArray<{ pluginId: string; release: string }>): PrivateAssetUrl {
  const releases = new Map(extensions.map((extension) => [extension.pluginId, extension.release]));
  return (ref) => {
    const release = releases.get(ref.app);
    return release ? `${storefrontExtensionBase(ref.app, release)}public/${ref.file.split("/").map(encodeURIComponent).join("/")}` : null;
  };
}
