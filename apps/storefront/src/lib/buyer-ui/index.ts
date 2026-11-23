import {
  BUYER_UI_BLOCKS_MAX,
  BUYER_UI_LINE_BLOCKS_MAX,
  buyerUiBlockSchema,
  type BuyerUiBlock,
  type CheckoutAttribute,
} from "@scalius/shared/plugins/buyer-ui";
import type { PluginUiButton, PluginUiImageSource, PluginUiNode, PluginUiTarget } from "@scalius/shared/plugins/ui";
import { formatNumber } from "@scalius/shared/locale-format";
import { pagePath } from "@/lib/presence-url";
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language-format";
import { buyerFieldModel } from "./field";
import { isCartSlot, isCheckoutSlot, readBuyerAttributes, writeBuyerAttribute } from "./state";
import { runBuyerUiAction, type RunnableAction } from "./actions";
import type { CartLineInputFacts } from "@/lib/cart/line-inputs";
import { onTextEdit } from "@/lib/text-edits";

export { readBuyerAttributes, clearBuyerAttributes } from "./state";
export interface BuyerUiOptions {
  /** Where the render's mounts are (default: the page's unscoped mounts); a scoped mount is drawn only by a render rooted in its scope. */
  root?: ParentNode;
  onChange?: () => void | Promise<void>;
  /** The slots this answer is for: mounts of other slots keep what they show (absent: every mount). */
  targets?: readonly string[];
  /** The cart's line input facts from the page's last check: a `set_line_input` button uses them instead of asking again. */
  lineInputs?: () => CartLineInputFacts;
}

/**
 * The control to focus once the blocks are drawn again after a line input
 * button changed the cart: the same app's button in the same mount (the
 * line keeps its place, its key changes), as the cart's own controls do.
 */
let pendingFocus: { target: string; appId: string; label: string; position: number; scope: Element | null; tries: number } | null = null;
let describedSequence = 0;

/** An app's button whose action did not run, in the page's language (the only words this renderer owns). */
const ACTION_FAILED = {
  en: "This action could not be completed. Try again.",
  bn: "কাজটি সম্পন্ন করা যায়নি। আবার চেষ্টা করুন।",
} as const;
const controlClass ="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const toneClasses = {
  neutral: "border-border bg-muted/40", info: "border-border bg-muted/40",
  // A tinted surface; the words stay in the text colour, readable in the light and the dark colours.
  success: "border-success/40 bg-success/10 text-foreground", warning: "border-warning/50 bg-warning/10 text-foreground",
  critical: "border-destructive/30 bg-destructive/10 text-destructive",
} as const;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A `file` question: its label and help now, the upload control (with its
 * behaviour, a chunk of its own) once it loads. Each new answer is saved like
 * any other and refreshes the surface.
 */
function uploadFieldNode(attribute: CheckoutAttribute, name: string, value: string, id: string, readonly: boolean, options: BuyerUiOptions): HTMLElement {
  const wrapper = element("div", "space-y-1");
  const label = element("label", "block text-sm font-medium text-foreground", attribute.label);
  label.htmlFor = id;
  const slot = element("div");
  slot.dataset.buyerUploadSlot = "";
  wrapper.append(label, slot);
  const describedBy: string[] = [];
  if (attribute.help) {
    const help = element("p", "text-sm text-muted-foreground", attribute.help);
    help.id = `${id}-help`; describedBy.push(help.id); wrapper.append(help);
  }
  void import("@/lib/buyer-uploads/attribute").then(({ mountBuyerUploadAttribute }) => mountBuyerUploadAttribute(wrapper, {
    attribute, name, id, value, readonly, describedBy,
    onAnswer: (answer) => { if (writeBuyerAttribute(name, answer)) void options.onChange?.(); },
  }), () => undefined);
  return wrapper;
}

function fieldNode(attribute: CheckoutAttribute, block: BuyerUiBlock, options: BuyerUiOptions, computed?: ReadonlyArray<{ value: string; label: string }>): HTMLElement {
  const name = `${block.appId}.${attribute.key}`;
  const checkout = isCheckoutSlot(block.target);
  // A cart surface shows the buyer's current answer; an order page the one it kept.
  const value = (isCartSlot(block.target) ? readBuyerAttributes()[name] : undefined) ?? block.values[attribute.key] ?? "";
  if (attribute.type === "file") return uploadFieldNode(attribute, name, value, `buyer-${block.target}-${name}`, !checkout, options);
  const model = buyerFieldModel(attribute, name, value, computed, document.documentElement.lang || "en");
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
  onTextEdit(control, () => {
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
  if (action.kind === "cart" && !isCartSlot(block.target)) return null;
  const buttonClass = "rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50";
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
      } else if (action.kind === "cart" && action.op === "set_line_input") {
        // The app's own line input, through the cart's own action (an island's `setLineInput` too). The
        // cart change itself checks the cart once: no refresh of its own.
        const { kind: _kind, op: _op, ...change } = action;
        const { setAppLineInput } = await import("@/lib/cart/island-cart");
        const mount = button.closest<HTMLElement>("[data-buyer-ui-target]");
        const scope = mount?.closest(SCOPE) ?? null;
        const mounts = [...document.querySelectorAll<HTMLElement>(`[data-buyer-ui-target="${CSS.escape(block.target)}"]`)].filter((each) => each.closest(SCOPE) === scope);
        const result = await setAppLineInput(block.appId, change, options.lineInputs?.());
        if (!result.ok && result.reason !== "cancelled") throw new Error(result.reason);
        if (result.ok && result.changed > 0) pendingFocus = { target: block.target, appId: block.appId, label: node.label, position: Math.max(0, mount ? mounts.indexOf(mount) : 0), scope, tries: 0 };
        return;
      } else {
        const result = await runBuyerUiAction(action as RunnableAction, block);
        if (result.message) status.textContent = result.message;
      }
      await options.onChange?.();
    } catch { status.textContent = ACTION_FAILED[checkoutLanguageBaseCode(document.documentElement.lang) === "bn" ? "bn" : "en"]; }
    finally { button.disabled = false; }
  });
  wrap.append(button, status); return wrap;
}

function keyValueText(value: string | number | boolean | null): string {
  if (typeof value === "number") return formatNumber(value, document.documentElement.lang || "en");
  if (typeof value === "boolean") return value ? "✓" : "—";
  return value ?? "—";
}

/**
 * One node, its kind on `data-ui` (`banner`, `text`, `button`, …) and its tone on
 * `data-tone`, inside the block's wrapper (`data-buyer-ui-app`) in its mount's
 * `data-buyer-ui-target`: the hooks a theme's tokens address an app's nodes by
 * (private-anatomy.ts `PRIVATE_BUYER_UI_STYLES`). No theme selector reaches them.
 */
function renderNode(node: PluginUiNode, block: BuyerUiBlock, options: BuyerUiOptions): HTMLElement | null {
  const rendered = drawNode(node, block, options);
  if (rendered) {
    rendered.dataset.ui = node.type;
    if ("tone" in node && typeof node.tone === "string") rendered.dataset.tone = node.tone;
  }
  return rendered;
}

function drawNode(node: PluginUiNode, block: BuyerUiBlock, options: BuyerUiOptions): HTMLElement | null {
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
      return attribute ? fieldNode(attribute, block, options, node.choices) : null;
    }
    case "button": return buttonNode(node, block, options);
    // The browser's own disclosure: it opens with a click, Enter or Space, and without this script's help.
    case "disclosure": {
      // A named group: the marker turns with its own disclosure, never an open ancestor's.
      const details = element("details", "group/disclosure rounded-md border border-border");
      details.open = node.open === true;
      const summary = element("summary", "flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-9 [&::-webkit-details-marker]:hidden");
      const marker = element("span", "shrink-0 transition-transform group-open/disclosure:rotate-180", "\u25BE");
      marker.setAttribute("aria-hidden", "true");
      summary.append(element("span", "min-w-0", node.summary), marker);
      const body = element("div", "flex flex-col gap-3 px-3 pb-3");
      for (const child of node.children) { const rendered = renderNode(child, block, options); if (rendered) body.append(rendered); }
      details.append(summary, body);
      return details;
    }
    // Admin-only nodes never pass the buyer surface's check.
    default: return null;
  }
}

const SCOPE = "[data-buyer-ui-scope]";

/**
 * The mounts one render owns: those under `root` (and `root` itself, when it
 * is a mount) whose nearest scope (`data-buyer-ui-scope`, e.g. the cart
 * drawer's mount) is the root's own, so a document-wide render never clears
 * a scoped mount it did not draw, nor a scoped render the page's mounts.
 */
function ownedMounts(root: ParentNode): HTMLElement[] {
  const scope = root instanceof Element ? root.closest(SCOPE) : null;
  const mounts = [...root.querySelectorAll<HTMLElement>("[data-buyer-ui-target]")];
  if (root instanceof HTMLElement && root.matches("[data-buyer-ui-target]")) mounts.unshift(root);
  return mounts.filter((mount) => mount.closest(SCOPE) === scope);
}

/** Replaces only the private mounts it owns; app content is always text or core-owned controls. */
export function renderBuyerUi(value: unknown, options: BuyerUiOptions = {}): void {
  const root = options.root ?? document;
  const blocks = (Array.isArray(value) ? value.slice(0, BUYER_UI_BLOCKS_MAX + BUYER_UI_LINE_BLOCKS_MAX) : []).flatMap((block) => {
    const parsed = buyerUiBlockSchema.safeParse(block); return parsed.success ? [parsed.data] : [];
  });
  for (const mount of ownedMounts(root)) {
    if (options.targets && !options.targets.includes(mount.dataset.buyerUiTarget ?? "")) continue;
    const nodes: HTMLElement[] = [];
    for (const block of blocks) {
      // A per-line block is drawn under its own line only (the mount's `data-buyer-ui-line`).
      if (block.target !== mount.dataset.buyerUiTarget || (block.lineKey ?? null) !== (mount.dataset.buyerUiLine ?? null)) continue;
      const node = renderNode(block.ui, block, options);
      if (!node) continue;
      // Each block in a wrapper naming its app: a host part a theme styles by tokens (`ui.<kind>@<app>`).
      const wrapper = element("div", "");
      wrapper.dataset.buyerUiApp = block.appId;
      wrapper.append(node);
      nodes.push(wrapper);
    }
    // A line's blocks name their line to assistive technology: each button is described by the line's name.
    const lineName = mount.dataset.buyerUiLineName;
    if (lineName && nodes.length > 0) {
      const name = element("span", "sr-only", lineName);
      name.id = `buyer-ui-line-${++describedSequence}`;
      nodes.unshift(name);
      for (const node of nodes) for (const button of node.querySelectorAll("button")) button.setAttribute("aria-describedby", name.id);
    }
    mount.replaceChildren(...nodes);
    mount.hidden = nodes.length === 0;
  }
  restoreFocus(root);
}

/** Focus returns to the clicked button's place once the cart's next blocks are drawn (given up after a few renders). */
function restoreFocus(root: ParentNode): void {
  const wanted = pendingFocus;
  if (!wanted) return;
  const mounts = ownedMounts(root).filter((mount) => mount.dataset.buyerUiTarget === wanted.target && mount.closest(SCOPE) === wanted.scope);
  const controls = [...(mounts[wanted.position]?.querySelectorAll<HTMLElement>(`[data-buyer-ui-app="${CSS.escape(wanted.appId)}"] :is(button,a,summary)`) ?? [])];
  const control = controls.find((each) => each.textContent === wanted.label) ?? controls[0];
  if (control) {
    control.focus();
    pendingFocus = null;
  } else if (mounts.length > 0 && ++wanted.tries >= 3) {
    pendingFocus = null;
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
