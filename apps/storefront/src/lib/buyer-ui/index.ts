import {
  buyerUiBlockSchema,
  type BuyerUiBlock,
  type BuyerUiNode,
  type CheckoutAttribute,
} from "@scalius/shared/plugins/buyer-ui";
import { pagePath } from "@/lib/presence-url";
import { buyerFieldModel } from "./field";
import { readBuyerAttributes, writeBuyerAttribute } from "./state";
import { runBuyerUiAction } from "./actions";

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
  const checkout = block.target.startsWith("purchase.checkout.");
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
export function buyerImagePath(src: Extract<BuyerUiNode, { type: "image" }>["src"], block: Pick<BuyerUiBlock, "appId" | "releaseId"> & { media?: Record<string, string> }): string | null {
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

function renderNode(node: BuyerUiNode, block: BuyerUiBlock, options: BuyerUiOptions): HTMLElement | null {
  switch (node.type) {
    case "stack": case "columns": {
      const container = element("div", node.type === "columns" ? "grid gap-3 sm:grid-cols-2" : "flex flex-col gap-3");
      for (const child of node.children) { const rendered = renderNode(child, block, options); if (rendered) container.append(rendered); }
      return container;
    }
    case "heading": return element("h3", "text-base font-semibold text-foreground", node.text);
    case "text": return element("p", "whitespace-pre-wrap break-words text-sm", node.text);
    case "badge": case "banner": {
      const container = element("div", `${node.type === "badge" ? "w-fit rounded-full px-2 py-1 text-xs" : "rounded-md p-3 text-sm"} border ${toneClasses[node.tone ?? "neutral"]}`);
      if (node.title) container.append(element("p", "font-medium", node.title));
      if (node.text) container.append(element("p", "whitespace-pre-wrap break-words", node.text));
      return container;
    }
    case "divider": return element("hr", "border-border");
    case "key-value": {
      const list = element("dl", "grid grid-cols-2 gap-x-3 gap-y-1 text-sm");
      for (const item of node.items) list.append(element("dt", "text-muted-foreground", item.label), element("dd", "break-words text-end", item.value));
      return list;
    }
    case "image": {
      const path = buyerImagePath(node.src, block);
      if (!path) return null;
      const image = element("img", "max-h-80 max-w-full rounded-md object-contain");
      image.src = path; image.alt = node.alt; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
      return image;
    }
    case "link": {
      const link = element("a", "text-sm underline underline-offset-2", node.text);
      link.href = pagePath(node.path); return link;
    }
    case "field": {
      const attribute = block.attributes.find((attribute) => attribute.key === node.attribute);
      return attribute ? fieldNode(attribute, block, options) : null;
    }
    case "button": {
      if (node.action.kind !== "app_route" && !block.target.startsWith("purchase.checkout.")) return null;
      const wrap = element("div", "space-y-1");
      const button = element("button", "rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50", node.label);
      button.type = "button";
      const status = element("p", "text-sm text-muted-foreground"); status.setAttribute("role", "status");
      button.addEventListener("click", async () => {
        button.disabled = true; status.textContent = "";
        try {
          if (node.action.kind === "set_attribute") {
            const action = node.action;
            if (!block.attributes.some((attribute) => attribute.key === action.key) || !writeBuyerAttribute(`${block.appId}.${action.key}`, action.value)) throw new Error();
          } else {
            const result = await runBuyerUiAction(node.action, block);
            if (result.message) status.textContent = result.message;
          }
          await options.onChange?.();
        } catch { status.textContent = "This action could not be completed. Try again."; }
        finally { button.disabled = false; }
      });
      wrap.append(button, status); return wrap;
    }
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
