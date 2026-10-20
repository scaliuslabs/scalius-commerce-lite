import {
  buyerUiBlockSchema,
  type BuyerUiBlock,
  type CheckoutAttribute,
} from "@scalius/shared/plugins/buyer-ui";
import type { PluginUiButton, PluginUiImageSource, PluginUiNode, PluginUiTarget } from "@scalius/shared/plugins/ui";
import { formatNumber } from "@scalius/shared/locale-format";
import { pagePath } from "@/lib/presence-url";
import { buyerFieldModel } from "./field";
import { isCheckoutSlot, readBuyerAttributes, writeBuyerAttribute } from "./state";
import { runBuyerUiAction, type RunnableAction } from "./actions";

export { readBuyerAttributes, clearBuyerAttributes } from "./state";
export interface BuyerUiOptions { root?: ParentNode; onChange?: () => void | Promise<void> }

const controlClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const toneClasses = {
  neutral: "border-border bg-muted/40", info: "border-border bg-muted/40",
  success: "border-green-200 bg-green-50 text-green-900", warning: "border-amber-200 bg-amber-50 text-amber-900",
  critical: "border-destructive/30 bg-destructive/10 text-destructive",
} as const;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fieldNode(attribute: CheckoutAttribute, block: BuyerUiBlock, options: BuyerUiOptions): HTMLElement {
  const name = `${block.appId}.${attribute.key}`;
  const checkout = isCheckoutSlot(block.target);
  const value = (checkout ? readBuyerAttributes()[name] : undefined) ?? block.values[attribute.key] ?? "";
  const model = buyerFieldModel(attribute, name, value);
  const wrapper = element("div", "space-y-1");
  const label = element("label", "block text-sm font-medium text-foreground", attribute.label);
  const control = element(model.tag, model.tag === "input" && attribute.type === "boolean" ? "h-4 w-4 accent-primary" : controlClass);
  control.id = `buyer-${block.target}-${name}`;
  control.dataset.buyerAttribute = name;
  label.htmlFor = control.id;
  for (const [key, input] of Object.entries(model.attributes)) {
    if (input === undefined || input === false) continue;
    control.setAttribute(key, input === true ? "" : String(input));
  }
  if (control instanceof HTMLSelectElement) {
    control.append(element("option"));
    for (const choice of model.choices) {
      const option = element("option", "", choice.label); option.value = choice.value; control.append(option);
    }
  }
  if (control instanceof HTMLTextAreaElement) control.rows = 2;
  control.value = value;
  if (control instanceof HTMLInputElement && attribute.type === "boolean") control.checked = model.checked;
  if (!checkout) control.disabled = true;
  wrapper.append(label, control);
  if (attribute.help) {
    const help = element("p", "text-sm text-muted-foreground", attribute.help);
    help.id = `${control.id}-help`; control.setAttribute("aria-describedby", help.id); wrapper.append(help);
  }
  control.addEventListener("input", () => {
    const current = control instanceof HTMLInputElement && attribute.type === "boolean" ? String(control.checked) : control.value;
    control.setCustomValidity(writeBuyerAttribute(name, current) ? "" : "This answer could not be saved. Try again.");
  });
  control.addEventListener("change", () => { if (control.checkValidity()) void options.onChange?.(); });
  return wrapper;
}

/** Media paths and immutable app assets only; an app cannot make the buyer fetch an arbitrary host. */
export function buyerImagePath(src: Exclude<PluginUiImageSource, string>, block: Pick<BuyerUiBlock, "appId" | "releaseId"> & { media?: Record<string, string> }): string | null {
  if ("app" in src) {
    if (!/^public\/[A-Za-z0-9_/-]+(?:\.[A-Za-z0-9]+)?$/.test(src.app) || src.app.includes("..")) return null;
    if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(block.appId) || !/^[A-Za-z0-9_-]+$/.test(block.releaseId)) return null;
    return `/_x/${block.appId}/${block.releaseId}/${src.app}`;
  }
  const stored = block.media?.[src.media];
  if (!stored) return null;
  let path: string;
  try { path = new URL(stored, "https://store.invalid").pathname; } catch { return null; }
  return /^\/media\/[A-Za-z0-9][A-Za-z0-9/_-]*\.[A-Za-z0-9]{1,10}(?:\/[1-9]\d{0,3}\.webp)?$/.test(path)
    && !path.includes("//") ? path : null;
}

/** A store link (the buyer surface allows no other kind). */
function storeHref(to: PluginUiTarget): string | null {
  return to.kind === "store" ? pagePath(to.path) : null;
}

function buttonNode(node: PluginUiButton, block: BuyerUiBlock, options: BuyerUiOptions): HTMLElement | null {
  const action = node.action;
  if (action.kind === "cart" && !isCheckoutSlot(block.target)) return null;
  const buttonClass = "rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
  if (action.kind === "navigate") {
    const href = storeHref(action.to);
    if (!href) return null;
    const link = element("a", `inline-flex w-fit ${buttonClass}`, node.label);
    link.href = href; return link;
  }
  const wrap = element("div", "space-y-1");
  const button = element("button", buttonClass, node.label);
  button.type = "button";
  button.disabled = node.disabled === true;
  const status = element("p", "text-sm text-muted-foreground"); status.setAttribute("role", "status");
  button.addEventListener("click", async () => {
    button.disabled = true; status.textContent = "";
    try {
      if (action.kind === "cart" && action.op === "set_attribute") {
        if (!block.attributes.some((attribute) => attribute.key === action.key) || !writeBuyerAttribute(`${block.appId}.${action.key}`, action.value)) throw new Error();
      } else {
        const result = await runBuyerUiAction(action as RunnableAction, block);
        if (result.message) status.textContent = result.message;
      }
      await options.onChange?.();
    } catch { status.textContent = "This action could not be completed. Try again."; }
    finally { button.disabled = false; }
  });
  wrap.append(button, status); return wrap;
}

function keyValueText(value: string | number | boolean | null): string {
  if (typeof value === "number") return formatNumber(value, document.documentElement.lang || "en");
  if (typeof value === "boolean") return value ? "✓" : "—";
  return value ?? "—";
}

function renderNode(node: PluginUiNode, block: BuyerUiBlock, options: BuyerUiOptions): HTMLElement | null {
  switch (node.type) {
    case "stack": case "columns": {
      const horizontal = node.type === "stack" && node.direction === "horizontal";
      const container = element("div", node.type === "columns" ? "grid gap-3 sm:grid-cols-2" : horizontal ? "flex flex-wrap items-center gap-3" : "flex flex-col gap-3");
      for (const child of node.children) { const rendered = renderNode(child, block, options); if (rendered) container.append(rendered); }
      return container;
    }
    case "heading": return element("h3", "text-base font-semibold text-foreground", node.text);
    case "text": return element("p", `whitespace-pre-wrap break-words ${node.size === "md" ? "text-base" : "text-sm"}${node.emphasis === "strong" ? " font-semibold" : ""}`, node.text);
    case "badge": return element("span", `w-fit rounded-full border px-2 py-1 text-xs ${toneClasses[node.tone ?? "neutral"]}`, node.text);
    case "banner": {
      const container = element("div", `rounded-md border p-3 text-sm ${toneClasses[node.tone]}`);
      if (node.title) container.append(element("p", "font-medium", node.title));
      if (node.text) container.append(element("p", "whitespace-pre-wrap break-words", node.text));
      for (const action of node.actions ?? []) { const rendered = buttonNode(action, block, options); if (rendered) container.append(rendered); }
      return container;
    }
    case "divider": return element("hr", "border-border");
    case "key-value": {
      const list = element("dl", "grid grid-cols-2 gap-x-3 gap-y-1 text-sm");
      for (const item of node.items) list.append(element("dt", "text-muted-foreground", item.label), element("dd", "break-words text-end", keyValueText(item.value)));
      return list;
    }
    case "image": {
      const path = typeof node.src === "string" ? null : buyerImagePath(node.src, block);
      if (!path) return null;
      const image = element("img", "max-h-80 max-w-full rounded-md object-contain");
      image.src = path; image.alt = node.alt; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
      if (node.width) image.width = node.width;
      if (node.height) image.height = node.height;
      return image;
    }
    case "link": {
      const href = storeHref(node.to);
      if (!href) return null;
      const link = element("a", "text-sm underline underline-offset-2", node.text);
      link.href = href; return link;
    }
    case "field": {
      const attribute = block.attributes.find((attribute) => attribute.key === node.attribute);
      return attribute ? fieldNode(attribute, block, options) : null;
    }
    case "button": return buttonNode(node, block, options);
    // Admin-only nodes never pass the buyer surface's check.
    default: return null;
  }
}

/** Replaces only the private mounts; app content is always text or core-owned controls. */
export function renderBuyerUi(value: unknown, options: BuyerUiOptions = {}): void {
  const root = options.root ?? document;
  const blocks = (Array.isArray(value) ? value.slice(0, 12) : []).flatMap((block) => {
    const parsed = buyerUiBlockSchema.safeParse(block); return parsed.success ? [parsed.data] : [];
  });
  for (const mount of root.querySelectorAll<HTMLElement>("[data-buyer-ui-target]")) {
    const nodes: HTMLElement[] = [];
    for (const block of blocks) {
      if (block.target !== mount.dataset.buyerUiTarget) continue;
      const node = renderNode(block.ui, block, options); if (node) nodes.push(node);
    }
    mount.replaceChildren(...nodes);
    mount.hidden = nodes.length === 0;
  }
}

/** Private server carriers use an escaped data attribute, never executable script. */
export function enhanceBuyerUi(root: ParentNode = document): void {
  for (const carrier of root.querySelectorAll<HTMLElement>("[data-buyer-ui]")) {
    try { renderBuyerUi(JSON.parse(carrier.dataset.buyerUi ?? "[]"), { root, onChange: () => { window.location.reload(); } }); }
    catch { renderBuyerUi([], { root }); }
    delete carrier.dataset.buyerUi;
  }
}
