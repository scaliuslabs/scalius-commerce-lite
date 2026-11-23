/**
 * A private page's arrangement as HTML (packages/plugin-sdk/docs/private-pages.md):
 * the host's layout nodes, its parts (the page's own markup, by name), the
 * apps' extension targets and the theme's content blocks, in the order the
 * arrangement gives. Server-side only: a page renders it once, from the
 * stored arrangement, with no read of its own. Every word is escaped, every
 * hook is checked on save, and nothing here writes a script or a handler.
 */
import { escapeHtml } from "@scalius/shared/html-escape";
import { storefrontExtensionBase } from "@scalius/shared/plugins/storefront-protocol";
import {
  PRIVATE_HOOK_ATTRIBUTE,
  privateWords,
  type PrivateAssetRef,
  type PrivateContentBlock,
  type PrivateContentTone,
  type PrivateLayoutKind,
  type PrivateNode,
} from "@scalius/shared/storefront-theme";

/** What draws each kind of node. */
export interface PrivateNodeRenderers {
  part(name: string, variant: string | undefined): string;
  target(name: string): string;
  /** A layout the page draws itself (the cart's fold, the drawer's scroll region); null: the host's plain box. */
  layout?(kind: PrivateLayoutKind, inner: string, hook: string | undefined): string | null;
  content(block: PrivateContentBlock, hook: string | undefined): string;
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

/** The nodes in order, each drawn by its renderer. */
export function renderPrivateNodes(nodes: readonly PrivateNode[], renderers: PrivateNodeRenderers): string {
  return nodes.map((node) => {
    if (node.type === "part") return renderers.part(node.part, node.variant);
    if (node.type === "target") return renderers.target(node.target);
    if (node.type === "content") return renderers.content(node.content, node.hook);
    const inner = renderPrivateNodes(node.children, renderers);
    return renderers.layout?.(node.layout, inner, node.hook) ?? layoutBox(node.layout, inner, node.hook);
  }).join("");
}

const TONES: Record<PrivateContentTone, string> = {
  neutral: "border-border bg-muted/40 text-foreground",
  info: "border-border bg-muted/40 text-foreground",
  success: "border-success/40 bg-success/10 text-foreground",
  warning: "border-warning/50 bg-warning/10 text-foreground",
  critical: "border-destructive/30 bg-destructive/10 text-destructive",
};

/** The URL of a file of the theme's app, when that app is active (its release names the path); else null. */
export type PrivateAssetUrl = (ref: PrivateAssetRef) => string | null;

/** The URL resolver over the store's active apps (`readStorefrontExtensions`): their releases, no code. */
export function privateAssetUrls(extensions: ReadonlyArray<{ pluginId: string; release: string }>): PrivateAssetUrl {
  const releases = new Map(extensions.map((extension) => [extension.pluginId, extension.release]));
  return (ref) => {
    const release = releases.get(ref.app);
    return release ? `${storefrontExtensionBase(ref.app, release)}public/${ref.file.split("/").map(encodeURIComponent).join("/")}` : null;
  };
}

/**
 * A theme content block as HTML in the page's language, inside its free
 * region (`data-free="block"` with the block's `data-hook`): the theme's
 * stylesheet styles what is inside, the host seals the box. Each block
 * carries its kind on `data-ui` (the buyer UI's names), so one stylesheet
 * styles the theme's blocks and the apps' alike. A block whose words or
 * image this language and store cannot fill draws nothing.
 */
export function privateContentHtml(block: PrivateContentBlock, hook: string | undefined, language: string, asset: PrivateAssetUrl): string {
  const html = contentHtml(block, language, asset);
  return html ? `<div data-free="block"${hookAttribute(hook)}>${html}</div>` : "";
}

function contentHtml(block: PrivateContentBlock, language: string, asset: PrivateAssetUrl): string {
  const words = (value: Parameters<typeof privateWords>[0]) => {
    const text = privateWords(value, language);
    return text === null ? "" : escapeHtml(text);
  };
  const attributes = (kind: string) => ` data-ui="${kind}"`;
  switch (block.kind) {
    case "heading": {
      const tag = block.level === 3 ? "h3" : "h2";
      const text = words(block.text);
      return text ? `<${tag}${attributes("heading")} class="text-base font-semibold text-foreground">${text}</${tag}>` : "";
    }
    case "text": {
      const text = words(block.text);
      return text ? `<p${attributes("text")}${block.tone ? ` data-tone="${block.tone}"` : ""} class="whitespace-pre-line text-sm ${block.tone === "critical" ? "text-destructive" : "text-muted-foreground"}">${text}</p>` : "";
    }
    case "link": {
      const text = words(block.text);
      return text ? `<a${attributes("link")} href="${escapeHtml(block.href)}" class="inline-flex min-h-11 items-center text-sm font-medium text-foreground underline underline-offset-2 hover:text-primary sm:min-h-9">${text}</a>` : "";
    }
    case "image": {
      const src = asset(block.image);
      return src ? `<img${attributes("image")} src="${escapeHtml(src)}" alt="${words(block.alt)}" width="${block.width}" height="${block.height}" loading="lazy" decoding="async" class="h-auto max-w-full">` : "";
    }
    case "banner": {
      const title = words(block.title);
      const text = words(block.text);
      if (!title && !text) return "";
      return `<div${attributes("banner")} data-tone="${block.tone}" role="note" class="rounded-lg border px-3 py-2 text-sm ${TONES[block.tone]}">${title ? `<p class="font-semibold">${title}</p>` : ""}${text ? `<p class="whitespace-pre-line">${text}</p>` : ""}</div>`;
    }
    case "disclosure": {
      const summary = words(block.summary);
      const text = words(block.text);
      return summary && text ? `<details${attributes("disclosure")} class="rounded-lg border border-border px-3 py-2 text-sm"><summary class="min-h-11 cursor-pointer py-2 font-medium text-foreground sm:min-h-0">${summary}</summary><p class="whitespace-pre-line pb-2 text-muted-foreground">${text}</p></details>` : "";
    }
    case "divider":
      return `<hr${attributes("divider")} class="border-border">`;
  }
}
