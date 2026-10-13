import { hydrateCartFromStorage, type VariantCartItem } from "@/store/cart";
import { cartItemVariantLabel } from "@/lib/cart/item-options";
import { pagePath } from "@/lib/presence-url";
import { formatCount } from "@/lib/store-time-zone";
import { formatConversationTime } from "@/lib/account-inbox";
import { pluralCategory } from "@scalius/shared/locale-words";
import {
  CART_SHARE_COPY as copy, CART_SHARE_LIMIT, parseConversationCartShare, sameSharedCartLines,
  validSharedCartLines, type ConversationCartShare, type SharedCartLine,
} from "@/lib/conversation-cart-share";

interface PreviewLine extends SharedCartLine { title: string; variantLabel: string | null; unavailable?: boolean }
type Write = { method: "PUT"; expectedVersion: number; lines: SharedCartLine[] } | { method: "DELETE"; expectedVersion: number };
const cleanups = new Map<HTMLElement, () => void>();
const countWords = (value: number, one: string, many: string) => `${formatCount(value)} ${pluralCategory(value, "en") === "one" ? one : many}`;

/** Merge personalized lines by SKU: the explicit preview contains only the quantities that will be shared. */
export function previewCart(items: readonly VariantCartItem[]): PreviewLine[] {
  const bySku = new Map<string, PreviewLine>();
  for (const item of items) {
    const existing = bySku.get(item.variantId);
    bySku.set(item.variantId, {
      productId: item.id, skuId: item.variantId, quantity: (existing?.quantity ?? 0) + item.quantity,
      title: item.name, variantLabel: cartItemVariantLabel(item.options),
    });
  }
  return [...bySku.values()];
}

function renderLines(list: HTMLElement, lines: readonly PreviewLine[]) {
  list.replaceChildren(...lines.map((line) => {
    const item = document.createElement("li");
    item.className = "flex items-start justify-between gap-4";
    const label = document.createElement("span");
    label.className = "min-w-0 break-words [overflow-wrap:anywhere]";
    label.textContent = line.title || "No longer available";
    if (line.variantLabel) {
      const variant = document.createElement("span");
      variant.className = "mt-0.5 block text-xs text-muted-foreground";
      variant.textContent = line.variantLabel; label.append(variant);
    }
    if (line.unavailable && line.title) {
      const unavailable = document.createElement("span");
      unavailable.className = "mt-0.5 block text-xs text-muted-foreground";
      unavailable.textContent = "No longer available"; label.append(unavailable);
    }
    const quantity = document.createElement("span");
    quantity.className = "shrink-0 text-muted-foreground";
    quantity.textContent = `Qty ${formatCount(line.quantity)}`;
    item.append(label, quantity); return item;
  }));
}

function bind(root: HTMLElement): () => void {
  const get = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-cart-share-${name}]`)!;
  const opener = get<HTMLButtonElement>("open");
  const update = get<HTMLButtonElement>("update");
  const stop = get<HTMLButtonElement>("stop");
  const expand = get<HTMLButtonElement>("expand");
  const confirm = get<HTMLButtonElement>("confirm");
  const retry = get<HTMLButtonElement>("retry");
  const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!;
  const title = dialog.querySelector("h2")!;
  const lifetime = new AbortController();
  let share: ConversationCartShare | null | undefined;
  let preview: PreviewLine[] | null = null;
  let previewVersion = 0;
  let pending: Write | null = null;
  let busy = false;
  let retryAction: (() => Promise<void>) | null = null;
  let open = false;
  let focusReturn: HTMLElement = opener;
  let priorOverflow = "";
  const inert = new Map<HTMLElement, boolean>();
  const alive = () => root.isConnected && !lifetime.signal.aborted;
  const active = () => share !== null && share !== undefined && share.withdrawnAt === null;
  const status = (text: string) => {
    get("status").textContent = text;
    get("dialog-status").textContent = open ? text : "";
  };
  const setRetry = (action: (() => Promise<void>) | null) => { retryAction = action; retry.hidden = !action; };
  const savedLines = (): PreviewLine[] => (share?.lines ?? []).map((line) => {
    const product = share?.products?.find((item) => item.skuId === line.skuId && item.productId === line.productId);
    return { ...line, title: product?.title ?? "", variantLabel: product?.variantLabel ?? null, unavailable: !product || product.status === "unavailable" };
  });
  const render = () => {
    const isActive = active();
    opener.hidden = share === undefined || isActive;
    get("row").hidden = !share;
    update.hidden = !isActive; stop.hidden = !isActive;
    expand.disabled = !isActive;
    get("summary").textContent = share ? share.withdrawnAt !== null
      ? `You stopped sharing your cart · ${formatConversationTime(share.withdrawnAt)}`
      : `Shared cart · ${countWords(new Set(share.lines.map((line) => line.productId)).size, "product", "products")} · ${formatConversationTime(share.sharedAt)}` : "";
    if (!isActive) { get("saved").hidden = true; expand.setAttribute("aria-expanded", "false"); }
    renderLines(get("saved-lines"), savedLines());
    for (const button of [opener, update, stop, retry]) button.disabled = busy;
    if (!preview) return;
    renderLines(get("preview"), preview);
    const products = countWords(new Set(preview.map((line) => line.productId)).size, "product", "products");
    const items = countWords(preview.reduce((sum, line) => sum + line.quantity, 0), "item", "items");
    title.textContent = `${isActive ? "Update shared cart:" : "Share"} ${products} (${items})?`;
    get("replaces").textContent = isActive ? `This replaces what you shared at ${formatConversationTime(share!.sharedAt)}.` : "";
    const empty = preview.length === 0;
    const invalid = preview.length > CART_SHARE_LIMIT || !validSharedCartLines(preview);
    const unchanged = isActive && sameSharedCartLines(preview, share!.lines);
    get("note").textContent = empty ? (isActive ? copy.emptyUpdate : copy.empty) : invalid ? copy.limits : unchanged ? copy.unchanged : copy.consent;
    confirm.hidden = empty && !isActive;
    confirm.textContent = busy ? "Checking…" : empty ? "Stop sharing" : isActive ? "Update shared cart" : "Share cart";
    confirm.disabled = busy || share === undefined || (!empty && (invalid || unchanged));
  };
  const close = () => {
    if (!open) return;
    open = false;
    try { dialog.hidePopover(); } catch { /* Already closed by light dismiss. */ }
    for (const [element, value] of inert) element.inert = value;
    inert.clear(); document.body.style.overflow = priorOverflow;
    dialog.removeAttribute("aria-modal");
    if (focusReturn.isConnected) focusReturn.focus();
  };
  const request = async (method: "GET" | "PUT" | "DELETE", write?: Write) => {
    try {
      const response = await fetch(pagePath(root.dataset.endpoint!), {
        method, credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", ...(write ? { "Content-Type": "application/json" } : {}) },
        ...(write ? { body: JSON.stringify({ expectedVersion: write.expectedVersion, ...(write.method === "PUT" ? { lines: write.lines } : {}) }) } : {}),
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(12_000)]),
      });
      const envelope = response.ok ? await response.json() as { success?: boolean; data?: { cartShare?: unknown } } : null;
      return { status: response.status, share: envelope?.success ? parseConversationCartShare(envelope.data?.cartShare) : undefined };
    } catch { return { status: 0, share: undefined }; }
  };
  const read = async () => {
    const result = await request("GET");
    if (!alive()) return false;
    if (result.share === undefined) { status(copy.loadFailed); return false; }
    // A slower GET cannot roll a successfully acknowledged version backwards.
    if ((result.share?.version ?? 0) >= (share?.version ?? 0)) share = result.share;
    render(); return true;
  };
  const succeeded = (value: ConversationCartShare, method: Write["method"]) => {
    share = value; pending = null; busy = false; setRetry(null); render();
    if (focusReturn.hidden) focusReturn = active() ? update : opener;
    close();
    status(method === "PUT" ? copy.sent : `You stopped sharing your cart · ${formatConversationTime(value.withdrawnAt)}`);
  };
  const write = async (intent: Write, mayRetryDelete = true): Promise<void> => {
    if (busy || !alive()) return;
    pending = intent; busy = true; setRetry(null); status("Checking…"); render();
    const result = await request(intent.method, intent);
    if (!alive()) return;
    if (result.share && result.share.version > intent.expectedVersion
      && (intent.method === "DELETE" ? result.share.withdrawnAt !== null : result.share.withdrawnAt === null && sameSharedCartLines(result.share.lines, intent.lines))) {
      succeeded(result.share, intent.method);
    } else if (result.status === 400 || result.status === 422) {
      pending = null; status(copy.unavailable);
    } else if ([401, 403, 404].includes(result.status)) {
      pending = null; status("This conversation isn't available. Reload to check your access.");
    } else {
      const refreshed = await read();
      if (!alive()) return;
      if (refreshed && share && ((intent.method === "DELETE" && share.withdrawnAt !== null)
        || (intent.method === "PUT" && share.version > intent.expectedVersion && share.withdrawnAt === null && sameSharedCartLines(share.lines, intent.lines)))) {
        succeeded(share, intent.method);
      } else if (refreshed && intent.method === "PUT" && result.status === 409) {
        pending = null; previewVersion = share?.version ?? 0; status(copy.conflict);
      } else if (refreshed && intent.method === "PUT" && (share?.version ?? 0) > intent.expectedVersion) {
        pending = null; previewVersion = share?.version ?? 0; status(copy.conflict);
      } else if (refreshed && intent.method === "DELETE" && result.status === 409 && share && mayRetryDelete) {
        busy = false; await write({ method: "DELETE", expectedVersion: share.version }, false); return;
      } else {
        status(intent.method === "PUT" ? copy.shareUnconfirmed : copy.stopUnconfirmed);
        setRetry(() => write(intent.method === "DELETE" && share ? { ...intent, expectedVersion: share.version } : intent, false));
      }
    }
    busy = false; render();
  };
  const load = async () => {
    busy = true; setRetry(null); status("Checking shared cart…"); render();
    const ok = await read();
    if (!alive()) return;
    busy = false;
    if (ok) status(""); else setRetry(load);
    render();
  };
  const show = async (event: Event) => {
    if (busy) return;
    focusReturn = event.currentTarget as HTMLElement;
    preview = previewCart(Object.values(hydrateCartFromStorage().items));
    pending = null; setRetry(null); open = true;
    dialog.showPopover(); dialog.setAttribute("aria-modal", "true");
    priorOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    let branch: HTMLElement = dialog;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) if (sibling instanceof HTMLElement && sibling !== branch) { inert.set(sibling, sibling.inert); sibling.inert = true; }
      if (branch.parentElement === document.body) break;
      branch = branch.parentElement;
    }
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    await load();
    if (!alive()) return;
    previewVersion = share?.version ?? 0; render();
  };
  const options = { signal: lifetime.signal };
  opener.addEventListener("click", (event) => void show(event), options);
  update.addEventListener("click", (event) => void show(event), options);
  stop.addEventListener("click", () => { if (share) void write({ method: "DELETE", expectedVersion: share.version }); }, options);
  confirm.addEventListener("click", () => {
    if (!preview || share === undefined || confirm.disabled) return;
    if (!preview.length) { if (share) void write({ method: "DELETE", expectedVersion: share.version }); return; }
    void write(pending ?? { method: "PUT", expectedVersion: previewVersion, lines: preview.map(({ productId, skuId, quantity }) => ({ productId, skuId, quantity })) });
  }, options);
  retry.addEventListener("click", () => { if (!busy) void retryAction?.(); }, options);
  expand.addEventListener("click", () => { const panel = get("saved"); panel.hidden = !panel.hidden; expand.setAttribute("aria-expanded", String(!panel.hidden)); }, options);
  dialog.addEventListener("toggle", (event) => { if ((event as ToggleEvent).newState === "closed") close(); }, options);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button:not([disabled])")].filter((button) => !button.hidden);
    const first = buttons[0]; const last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }, options);
  const changed = () => {
    lifetime.abort(); close(); share = undefined; preview = null; pending = null;
    get("saved-lines").replaceChildren(); get("preview").replaceChildren();
    status(copy.accountChanged); setRetry(null); get("row").hidden = true; opener.hidden = true;
  };
  window.addEventListener("customer-login", changed, options);
  window.addEventListener("customer-logout", changed, options);
  void load();
  return () => { lifetime.abort(); close(); };
}

export function bindConversationCartShares(): void {
  for (const [root, cleanup] of cleanups) if (!root.isConnected) { cleanup(); cleanups.delete(root); }
  document.querySelectorAll<HTMLElement>("[data-conversation-cart-share]").forEach((root) => {
    if (!cleanups.has(root)) cleanups.set(root, bind(root));
  });
}

export function stopConversationCartShares(): void {
  for (const cleanup of cleanups.values()) cleanup();
  cleanups.clear();
}
