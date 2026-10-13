// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindConversationCartShares, previewCart, stopConversationCartShares } from "./cart-share";
import type { ConversationCartShare } from "@/lib/conversation-cart-share";
import type { VariantCartItem } from "@/store/cart";

const cart = vi.hoisted(() => ({ items: {} as Record<string, VariantCartItem> }));
vi.mock("@/store/cart", () => ({ hydrateCartFromStorage: () => cart }));
vi.mock("@/lib/presence-url", () => ({ pagePath: (path: string) => path }));
vi.mock("@/lib/account-inbox", () => ({ formatConversationTime: (time: number) => `time ${time}` }));
vi.mock("@/lib/store-time-zone", () => ({ formatCount: (count: number) => String(count) }));
const item = (overrides: Partial<VariantCartItem> = {}): VariantCartItem => ({ id: "prod_a", variantId: "sku_a", name: "Bag", quantity: 2, price: 100, ...overrides });
const line = { productId: "prod_a", skuId: "sku_a", quantity: 2 };
const shared = (overrides: Partial<ConversationCartShare> = {}): ConversationCartShare => ({ lines: [line], products: [{ ...line, title: "Shared bag", variantLabel: "Blue", status: "available" }], sharedAt: 100, withdrawnAt: null, version: 1, ...overrides });
const answer = (cartShare: ConversationCartShare | null) => Response.json({ success: true, data: { cartShare } });
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const node = <T extends HTMLElement = HTMLElement>(name: string) => document.querySelector<T>(`[data-cart-share-${name}]`)!;
const click = (name: string) => node<HTMLButtonElement>(name).click();
const mutations = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method !== "GET");
let dialog: HTMLElement;

beforeEach(() => {
  cart.items = { a: item() };
  document.body.innerHTML = `<main><textarea id="composer">Draft stays here</textarea><div data-conversation-cart-share data-endpoint="/api/conversations/cnv_12345678/cart-share">
    <div data-cart-share-row hidden><button data-cart-share-expand><span data-cart-share-summary></span></button><button data-cart-share-update>Update</button><button data-cart-share-stop>Stop sharing</button><div data-cart-share-saved hidden><ul data-cart-share-saved-lines></ul></div></div>
    <button data-cart-share-open hidden>Share my cart</button><p data-cart-share-status></p><button data-cart-share-retry hidden>Try again</button>
    <div role="dialog" popover><h2></h2><button data-close>Close</button><ul data-cart-share-preview></ul><p data-cart-share-note></p><p data-cart-share-replaces></p><p data-cart-share-dialog-status></p><button data-cart-share-confirm>Share cart</button></div>
  </div></main>`;
  dialog = document.querySelector('[role="dialog"]')!;
  dialog.showPopover = vi.fn(); dialog.hidePopover = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(answer(null))));
});
afterEach(() => { stopConversationCartShares(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe("explicit conversation cart consent", () => {
  it("only reads on mount and preview; confirmation shares exactly what was previewed", async () => {
    bindConversationCartShares(); await settle(); click("open"); await settle();
    expect(mutations()).toHaveLength(0);
    expect(node("preview").textContent).toContain("Bag");
    expect(node("preview").textContent).not.toContain("100");
    cart.items = { b: item({ id: "prod_b", variantId: "sku_b", name: "New cart" }) };
    vi.mocked(fetch).mockResolvedValueOnce(answer(shared()));
    click("confirm"); await settle();
    expect(JSON.parse(mutations()[0]![1]!.body as string)).toEqual({ expectedVersion: 0, lines: [line] });
    expect(node("status").textContent).toContain("Staff aren't notified");
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Draft stays here");
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(node("update"));
  });
  it("aggregates the shown SKU quantities without exposing personalized properties", () => {
    expect(previewCart([item(), item({ quantity: 3 })])).toEqual([{ ...line, quantity: 5, title: "Bag", variantLabel: null }]);
  });
  it("blocks quantities over the share limit instead of silently clamping", async () => {
    cart.items = { a: item({ quantity: 60 }), b: item({ quantity: 60 }) };
    bindConversationCartShares(); await settle(); click("open"); await settle();
    expect(node<HTMLButtonElement>("confirm").disabled).toBe(true);
    expect(node("note").textContent).toContain("up to 99");
    expect(node("preview").textContent).toContain("120");
  });
  it("shows the server's saved snapshot, not whatever is currently in the cart", async () => {
    cart.items = { b: item({ name: "Changed local name" }) };
    vi.mocked(fetch).mockResolvedValue(answer(shared()));
    bindConversationCartShares(); await settle(); click("expand");
    expect(node("saved-lines").textContent).toContain("Shared bag");
    expect(node("saved-lines").textContent).not.toContain("Changed local name");
    click("update"); await settle();
    expect(node<HTMLButtonElement>("confirm").disabled).toBe(true);
    expect(node("note").textContent).toContain("No changes");
  });
  it("uses DELETE when an update finds an empty cart", async () => {
    cart.items = {};
    vi.mocked(fetch).mockResolvedValue(answer(shared()));
    bindConversationCartShares(); await settle(); click("update"); await settle();
    expect(node("confirm").textContent).toBe("Stop sharing");
    vi.mocked(fetch).mockResolvedValueOnce(answer(shared({ lines: [], withdrawnAt: 101, version: 2 })));
    click("confirm"); await settle();
    expect(mutations()[0]![1]!.method).toBe("DELETE");
    expect(JSON.parse(mutations()[0]![1]!.body as string)).toEqual({ expectedVersion: 1 });
  });
  it("keeps an empty cart discoverable without allowing an empty PUT", async () => {
    cart.items = {}; bindConversationCartShares(); await settle(); click("open"); await settle();
    expect(node("confirm").hidden).toBe(true);
    expect(node("note").textContent).toContain("Your cart is empty");
    expect(mutations()).toHaveLength(0);
  });
  it("reconciles a lost PUT response against the durable matching snapshot", async () => {
    bindConversationCartShares(); await settle(); click("open"); await settle();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(answer(shared()));
    click("confirm"); await settle();
    expect(mutations()).toHaveLength(1);
    expect(node("status").textContent).toContain("Cart shared");
    expect(node("retry").hidden).toBe(true);
  });
  it("requires another explicit confirmation after a conflicting share", async () => {
    bindConversationCartShares(); await settle(); click("open"); await settle();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 409 })).mockResolvedValueOnce(answer(shared({ lines: [{ ...line, quantity: 8 }], version: 4 })));
    click("confirm"); await settle();
    expect(mutations()).toHaveLength(1);
    expect(node("dialog-status").textContent).toContain("another window");
    expect(node("preview").textContent).toContain("Qty 2");
    vi.mocked(fetch).mockResolvedValueOnce(answer(shared({ version: 5 })));
    click("confirm"); await settle();
    expect(JSON.parse(mutations()[1]![1]!.body as string)).toEqual({ expectedVersion: 4, lines: [line] });
  });
  it("recognizes a committed share when both its acknowledgement and first reconciliation were lost", async () => {
    bindConversationCartShares(); await settle(); click("open"); await settle();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockRejectedValueOnce(new Error("offline reconciliation"));
    click("confirm"); await settle();
    expect(node("retry").hidden).toBe(false);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(answer(shared()));
    click("retry"); await settle();
    expect(mutations()).toHaveLength(2);
    expect(mutations()[0]![1]!.body).toBe(mutations()[1]![1]!.body);
    expect(node("status").textContent).toContain("Cart shared");
    expect(node("retry").hidden).toBe(true);
    expect(dialog.hidePopover).toHaveBeenCalled();
  });
  it("retries an unconfirmed PUT with the same payload and expected version", async () => {
    bindConversationCartShares(); await settle(); click("open"); await settle();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce(answer(null));
    click("confirm"); await settle();
    expect(node("status").textContent).toContain("Couldn't confirm");
    vi.mocked(fetch).mockResolvedValueOnce(answer(shared()));
    click("confirm"); await settle();
    expect(mutations()[0]![1]!.body).toBe(mutations()[1]![1]!.body);
  });
  it("retries a conflicted withdrawal once against the fresh version", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(answer(shared())); bindConversationCartShares(); await settle();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(answer(shared({ version: 3 })))
      .mockResolvedValueOnce(answer(shared({ lines: [], withdrawnAt: 102, version: 4 })));
    click("stop"); await settle();
    expect(mutations()).toHaveLength(2);
    expect(JSON.parse(mutations()[1]![1]!.body as string)).toEqual({ expectedVersion: 3 });
    expect(node("summary").textContent).toContain("stopped sharing");
    expect(node("saved-lines").textContent).toBe("");
  });
  it("never interprets an active empty snapshot as withdrawn", async () => {
    vi.mocked(fetch).mockResolvedValue(answer(shared({ lines: [], products: [] })));
    bindConversationCartShares(); await settle();
    expect(node("summary").textContent).toContain("Shared cart");
    expect(node("stop").hidden).toBe(false);
  });
  it("keeps a validation failure visible in the open preview without retrying", async () => {
    bindConversationCartShares(); await settle(); click("open"); await settle();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 400 }));
    click("confirm"); await settle();
    expect(node("dialog-status").textContent).toContain("Some items can't");
    expect(node("preview").textContent).toContain("Bag");
    expect(dialog.hidePopover).not.toHaveBeenCalled();
    expect(mutations()).toHaveLength(1);
  });
  it("ignores a late response and clears private preview content after identity changes", async () => {
    bindConversationCartShares(); await settle(); click("open"); await settle();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    click("confirm"); window.dispatchEvent(new Event("customer-logout"));
    finish(answer(shared())); await settle();
    expect(node("status").textContent).toContain("account changed");
    expect(node("preview").textContent).toBe("");
    expect(node("open").hidden).toBe(true);
    expect(document.querySelector("main")!.inert).toBe(false);
  });
});
