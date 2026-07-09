// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import StorefrontAssistantBubble from "./StorefrontAssistantBubble";
import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  buildStorefrontAssistantPageContext,
  type StorefrontAssistantPageContextSnapshot,
} from "@/lib/assistant-page-context";
import { ASSISTANT_GEOMETRY_STORAGE_KEY } from "./assistant-geometry";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type StorefrontAssistantBridge = {
  getContext: () => StorefrontAssistantPageContextSnapshot | null;
  navigate: (target: unknown) => boolean;
};

function installMemoryStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

describe("StorefrontAssistantBubble", () => {
  let root: Root;
  let host: HTMLDivElement;
  let currentContext: StorefrontAssistantPageContextSnapshot;
  let navigate: Mock<(target: unknown) => boolean>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    installMemoryStorage();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/products/rice");
    navigate = vi.fn<(target: unknown) => boolean>(() => true);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    currentContext = buildStorefrontAssistantPageContext({
      path: "/products/rice?receiptToken=chk_private_receipt",
      route: "/products/[slug]",
      canonicalUrl:
        "https://shop.example.test/products/rice?token=chk_private_receipt",
      title: "Rice buyer@example.test",
      cart: {
        items: {
          line_1: {
            id: "prod_rice",
            variantId: "var_rice",
            slug: "rice",
            name: "Premium Rice 01711111111",
            price: 100,
            quantity: 1,
            options: [{ name: "Pack", label: "Bearer abc.def.ghi" }],
          },
        },
        totalItems: 1,
        totalAmount: 100,
        discount: {
          id: "discount_1",
          code: "SECRET10",
          type: "coupon",
          valueType: "fixed",
          discountValue: 10,
          discountAmount: 10,
        },
      },
    });
    window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL] = currentContext;
    window.__SCALIUS_STOREFRONT_ASSISTANT__ = {
      getContext: () => currentContext,
      navigate,
    } satisfies StorefrontAssistantBridge;

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL];
    delete window.__SCALIUS_STOREFRONT_ASSISTANT__;
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("posts bounded sanitized context to the same-origin proxy without credentials", async () => {
    const hiddenInput = document.createElement("input");
    hiddenInput.value = "HiddenCustomerSecret";
    document.body.append(hiddenInput);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          message: { role: "assistant", content: "Premium Rice is available." },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await typeAssistantMessage("Do you have rice?");
    await click(queryButton("Send storefront assistant message"));
    await flushReact();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/assistant/chat");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
    });
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);

    const body = JSON.parse(String(init.body)) as {
      message: string;
      history: unknown[];
      pageContext: StorefrontAssistantPageContextSnapshot;
    };
    const serialized = JSON.stringify(body);
    expect(body.message).toBe("Do you have rice?");
    expect(body.history).toEqual([]);
    expect(body.pageContext.page.path).toBe("/products/rice");
    expect(body.pageContext.cart.lines[0]?.name).toBe(
      "Premium Rice [redacted-phone]",
    );
    expect(serialized).not.toContain("buyer@example.test");
    expect(serialized).not.toContain("01711111111");
    expect(serialized).not.toContain("chk_private_receipt");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("SECRET10");
    expect(serialized).not.toContain("HiddenCustomerSecret");
    expect(document.body.textContent).toContain("Premium Rice is available.");
  });

  it("renders assistant text safely and click-confirms only safe navigation actions", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          message: {
            role: "assistant",
            content: "Open <script>alert('xss')</script> the rice page.",
          },
          actions: [
            { type: "navigate", path: "/products/rice", label: "Open Rice" },
            { type: "navigate", path: "/checkout", label: "Checkout" },
            { type: "navigate", path: "/account", label: "Account" },
            {
              type: "navigate",
              path: "https://evil.example.test/products/rice",
              label: "Off Origin",
            },
            {
              type: "navigate",
              path: "/products/%2e%2e/cart",
              label: "Traversal",
            },
            {
              type: "navigate",
              path: "/orders/status/cst_private_status",
              label: "Order Status",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await typeAssistantMessage("Open rice");
    await click(queryButton("Send storefront assistant message"));
    await flushReact();

    expect(document.body.textContent).toContain(
      "Open <script>alert('xss')</script> the rice page.",
    );
    expect(document.body.querySelector("script")).toBeNull();
    expect(queryButton("Open Rice")).toBeTruthy();
    expect(queryButton("Checkout")).toBeNull();
    expect(queryButton("Account")).toBeNull();
    expect(queryButton("Off Origin")).toBeNull();
    expect(queryButton("Traversal")).toBeNull();
    expect(queryButton("Order Status")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    await click(queryButton("Open Rice"));
    expect(navigate).toHaveBeenCalledWith("/products/rice");
  });

  it("supports keyboard positioning, docking, sizing, mobile fullscreen, and focus return", async () => {
    renderBubble();
    await flushReact();

    const launcher = queryButton("Open storefront assistant");
    expect(launcher).toBeTruthy();
    const initialGeometry = JSON.parse(
      window.localStorage.getItem(ASSISTANT_GEOMETRY_STORAGE_KEY) ?? "{}",
    ) as { launcherX: number };
    await keyDown(launcher, "ArrowLeft");
    const movedGeometry = JSON.parse(
      window.localStorage.getItem(ASSISTANT_GEOMETRY_STORAGE_KEY) ?? "{}",
    ) as { launcherX: number };
    expect(movedGeometry.launcherX).toBe(initialGeometry.launcherX - 32);
    expect(document.body.textContent).toContain(
      "Assistant launcher moved left.",
    );

    await click(launcher);
    const panel = document.querySelector<HTMLElement>(
      "#storefront-assistant-panel",
    );
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-modal")).toBe("false");
    expect(document.activeElement).toBe(
      document.querySelector(
        'textarea[aria-label="Message storefront assistant"]',
      ),
    );

    await click(queryButton("Dock panel left"));
    expect(panel?.dataset.mode).toBe("dock-left");
    await click(queryButton("Make assistant wider"));
    const dockedGeometry = JSON.parse(
      window.localStorage.getItem(ASSISTANT_GEOMETRY_STORAGE_KEY) ?? "{}",
    ) as { mode: string; panelWidth: number };
    expect(dockedGeometry.mode).toBe("dock-left");
    expect(dockedGeometry.panelWidth).toBeGreaterThan(424);

    await click(queryButton("Open full screen"));
    expect(panel?.dataset.mobileFullscreen).toBe("true");

    await keyDown(panel, "Escape");
    const restoredLauncher = queryButton("Open storefront assistant");
    expect(restoredLauncher).toBeTruthy();
    expect(document.activeElement).toBe(restoredLauncher);
  });

  it("renders supplied rich product and comparison parts with manual checkout fallback", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          message: {
            id: "message_rich",
            parts: [
              { type: "text", text: "These are the closest matches." },
              {
                type: "product_grid",
                title: "Recommended products",
                products: [
                  {
                    id: "product_rice",
                    title: "Premium Rice",
                    path: "/products/rice",
                    price: 850,
                    currency: "BDT",
                    availability: "in_stock",
                    badges: ["Popular"],
                  },
                ],
              },
              {
                type: "handoff",
                title: "Continue securely",
                description: "Complete checkout in the storefront form.",
                path: "/checkout",
                handoffType: "checkout",
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await typeAssistantMessage("Recommend rice");
    await click(queryButton("Send storefront assistant message"));
    await flushReact();

    expect(document.body.textContent).toContain("Recommended products");
    expect(document.body.textContent).toContain("Premium Rice");
    expect(document.body.textContent).toContain(
      "Use the visible cart or checkout controls to continue manually.",
    );
    expect(queryButton("View Premium Rice")).toBeTruthy();
    expect(queryButton("Continue manually")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    await click(queryButton("View Premium Rice"));
    expect(navigate).toHaveBeenCalledWith("/products/rice");
  });

  function renderBubble() {
    act(() => {
      root.render(<StorefrontAssistantBubble />);
    });
  }
});

function queryButton(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
}

async function click(element: HTMLElement | null) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await flushReact();
}

async function keyDown(element: HTMLElement | null, key: string) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await flushReact();
}

async function typeAssistantMessage(value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message storefront assistant"]',
  );
  expect(textarea).toBeTruthy();

  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(textarea, value);
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flushReact();
}

async function flushReact() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
