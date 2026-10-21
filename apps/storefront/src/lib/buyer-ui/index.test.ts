// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuyerUiBlock } from "@scalius/shared/plugins/buyer-ui";
import { buyerImagePath, readBuyerAttributes, renderBuyerUi } from "./index";

vi.mock("./actions", () => ({ runBuyerUiAction: vi.fn(async () => ({ message: "Done" })) }));
const target = "checkout.contact.after";
const block = (ui: BuyerUiBlock["ui"], extras: Partial<BuyerUiBlock> = {}): BuyerUiBlock => ({
  appId: "acme.notes", releaseId: "release123", target, ui, attributes: [], values: {}, ...extras,
});

beforeEach(() => {
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-market-presence");
  document.body.innerHTML = `<div data-buyer-ui-target="${target}"></div>`;
});

describe("host-owned buyer UI", () => {
  it("renders app text literally and refuses HTML nodes and external links", () => {
    renderBuyerUi([block({ type: "text", text: '<img src=x onerror="alert(1)">' })]);
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("<img src=x");
    renderBuyerUi([block({ type: "link", text: "Bad", to: { kind: "external", href: "https://other.test/" } })]);
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector<HTMLElement>("[data-buyer-ui-target]")?.hidden).toBe(true);
  });

  it("takes only declared fields, stores namespaced values, and asks the host to refresh", async () => {
    const onChange = vi.fn();
    renderBuyerUi([block({ type: "stack", children: [{ type: "field", attribute: "note" }, { type: "field", attribute: "undeclared" }] }, {
      attributes: [{ key: "note", label: "Gift note", type: "multiline", required: true, maxLength: 100 }],
    })], { onChange });
    const input = document.querySelector("textarea")!;
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
    expect(input.required).toBe(true);
    expect(input.maxLength).toBe(100);
    input.value = "A private gift message";
    input.dispatchEvent(new Event("input")); input.dispatchEvent(new Event("change"));
    expect(readBuyerAttributes()).toEqual({ "acme.notes.note": "A private gift message" });
    expect(onChange).toHaveBeenCalledOnce();
    expect(document.querySelector("a")).toBeNull();
  });

  it("shows the historical order value on read-only targets, ignoring another checkout draft", () => {
    sessionStorage.setItem("scalius:buyer-attributes", JSON.stringify({ "acme.notes.note": "New draft" }));
    const orderTarget = "account.order";
    document.body.innerHTML = `<div data-buyer-ui-target="${orderTarget}"></div>`;
    renderBuyerUi([block({ type: "field", attribute: "note" }, {
      target: orderTarget, attributes: [{ key: "note", label: "Note", type: "text" }], values: { note: "Saved answer" },
    })]);
    expect(document.querySelector("input")?.value).toBe("Saved answer");
    expect(document.querySelector("input")?.disabled).toBe(true);
  });

  it("requires an explicit boolean answer and accepts false", () => {
    renderBuyerUi([block({ type: "field", attribute: "wrap" }, {
      attributes: [{ key: "wrap", label: "Gift wrap", type: "boolean", required: true }],
    })]);
    const input = document.querySelector("select")!;
    expect(input.checkValidity()).toBe(false);
    input.value = "false"; input.dispatchEvent(new Event("input"));
    expect(input.checkValidity()).toBe(true);
    expect(readBuyerAttributes()["acme.notes.wrap"]).toBe("false");
  });

  it("allows only mapped store media and the matching release's public files", () => {
    const source = { appId: "acme.notes", releaseId: "release123", media: { picture: "https://media.store.test/media/m_123.jpg" } };
    expect(buyerImagePath({ media: "picture" }, source)).toBe("/media/m_123.jpg");
    expect(buyerImagePath({ media: "https://tracker.test/pixel" }, source)).toBeNull();
    expect(buyerImagePath({ app: "public/badge.svg" }, source)).toBe("/_x/acme.notes/release123/public/badge.svg");
    expect(buyerImagePath({ app: "public/../private.txt" }, source)).toBeNull();
  });

  it("keeps presence links and drops checkout mutations from account surfaces", () => {
    document.documentElement.dataset.marketPresence = "en-in";
    renderBuyerUi([block({ type: "link", text: "Shop", to: { kind: "store", path: "/products/gift" } })]);
    expect(document.querySelector("a")?.getAttribute("href")).toBe("/en-in/products/gift");
    const accountTarget = "account.profile";
    document.body.innerHTML = `<div data-buyer-ui-target="${accountTarget}"></div>`;
    renderBuyerUi([block({ type: "button", label: "Apply", action: { kind: "cart", op: "apply_code", code: "BAD" } }, { target: accountTarget })]);
    expect(document.querySelector("button")).toBeNull();
  });
});

describe("scoped mounts (the cart drawer)", () => {
  const drawer = "cart_drawer.footer";
  const page = () => document.querySelector<HTMLElement>(`[data-buyer-ui-target="${target}"]`)!;
  const scoped = () => document.querySelector<HTMLElement>(`[data-buyer-ui-target="${drawer}"]`)!;
  beforeEach(() => {
    document.body.innerHTML = `<div data-buyer-ui-target="${target}"></div>
      <aside><div data-buyer-ui-scope data-buyer-ui-target="${drawer}" hidden></div></aside>`;
  });

  it("a page-wide render never draws or clears the drawer's mount, nor the drawer's render the page's", () => {
    renderBuyerUi([block({ type: "text", text: "Drawer" }, { target: drawer })], { root: scoped() });
    expect(scoped().textContent).toBe("Drawer");
    expect(scoped().hidden).toBe(false);
    // The cart page's own render (with or without drawer blocks) leaves it alone.
    renderBuyerUi([block({ type: "text", text: "Page" }), block({ type: "text", text: "Other" }, { target: drawer })]);
    expect(page().textContent).toBe("Page");
    expect(scoped().textContent).toBe("Drawer");
    renderBuyerUi([]);
    expect(scoped().textContent).toBe("Drawer");
    expect(page().hidden).toBe(true);
    // And the drawer's render leaves the page's mount alone.
    renderBuyerUi([block({ type: "text", text: "Page again" })]);
    renderBuyerUi([], { root: scoped() });
    expect(scoped().hidden).toBe(true);
    expect(page().textContent).toBe("Page again");
  });

  it("runs cart operations in the drawer and shows a field's current answer read-only", async () => {
    const onChange = vi.fn();
    sessionStorage.setItem("scalius:buyer-attributes", JSON.stringify({ "acme.notes.note": "Current draft" }));
    renderBuyerUi([block({ type: "stack", children: [
      { type: "field", attribute: "note" },
      { type: "button", label: "Apply", action: { kind: "cart", op: "apply_code", code: "SAVE" } },
      { type: "button", label: "Wrap it", action: { kind: "cart", op: "set_attribute", key: "note", value: "Wrap" } },
    ] }, { target: drawer, attributes: [{ key: "note", label: "Note", type: "text" }], values: { note: "Stale" } })], { root: scoped(), onChange });
    const input = scoped().querySelector("input")!;
    expect(input.value).toBe("Current draft");
    expect(input.disabled).toBe(true);
    const buttons = [...scoped().querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Apply", "Wrap it"]);
    buttons[1]!.click();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(readBuyerAttributes()).toEqual({ "acme.notes.note": "Wrap" });
  });
});
