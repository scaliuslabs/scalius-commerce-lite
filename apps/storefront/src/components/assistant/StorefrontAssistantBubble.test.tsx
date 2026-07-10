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

const transcriptMocks = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  retry: vi.fn(),
  getConversationId: vi.fn(() =>
    Promise.resolve("conv_abcdefghijklmnopqrstuv")
  ),
}));

vi.mock("./useStorefrontAssistantTranscript", () => ({
  useStorefrontAssistantTranscript: () => ({
    state: {
      kind: "connected",
      message: "This tab's private transcript is connected.",
    },
    appendMessage: transcriptMocks.appendMessage,
    retry: transcriptMocks.retry,
    getConversationId: transcriptMocks.getConversationId,
  }),
}));

import StorefrontAssistantBubble from "./StorefrontAssistantBubble";
import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  buildStorefrontAssistantPageContext,
  type StorefrontAssistantPageContextSnapshot,
} from "@/lib/assistant-page-context";
import { ASSISTANT_GEOMETRY_STORAGE_KEY } from "./assistant-geometry";
import { installMemoryBrowserStorage } from "./assistant-test-storage";
import { STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY } from
  "./storefront-assistant-open-state";
import { STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY } from
  "./storefront-assistant-session";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type StorefrontAssistantBridge = {
  getContext: () => StorefrontAssistantPageContextSnapshot | null;
  navigate: (target: unknown) => boolean;
};

describe("StorefrontAssistantBubble", () => {
  let root: Root;
  let host: HTMLDivElement;
  let currentContext: StorefrontAssistantPageContextSnapshot;
  let navigate: Mock<(target: unknown) => boolean>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    installMemoryBrowserStorage();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/products/rice");
    navigate = vi.fn<(target: unknown) => boolean>(() => true);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    transcriptMocks.appendMessage.mockReset();
    transcriptMocks.appendMessage.mockImplementation(async (input: {
      content: string;
      contextMarker: string;
    }) => ({
      eventId: "event_user_1",
      sequence: 1,
      type: "message.appended",
      occurredAt: 1,
      message: {
        id: "durable_user_1",
        role: "user",
        content: input.content,
        contextMarker: input.contextMarker,
        createdAt: 1,
      },
    }));
    transcriptMocks.retry.mockReset();
    transcriptMocks.getConversationId.mockClear();

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
    appendAssistantHost(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL];
    delete window.__SCALIUS_STOREFRONT_ASSISTANT__;
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete document.documentElement.dataset.storefrontAssistantHydrated;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts bounded sanitized context to the per-tab same-origin proxy without exposing credentials", async () => {
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
    expect(url).toBe(
      "/api/assistant/conversations/conv_abcdefghijklmnopqrstuv/chat",
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      mode: "same-origin",
    });
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);

    const body = JSON.parse(String(init.body)) as {
      clientRequestId: string;
      message: string;
      history: unknown[];
      pageContext: StorefrontAssistantPageContextSnapshot;
    };
    const serialized = JSON.stringify(body);
    expect(body.message).toBe("Do you have rice?");
    expect(body.clientRequestId).toMatch(/^chat_[A-Za-z0-9_-]{22}$/);
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
    await typeAssistantMessage("Where can I find rice?");
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

  it("navigates once for an exact current-turn destination command", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        status: "ok",
        message: {
          role: "assistant",
          content: "Opening the catalog results.",
          parts: [{
            type: "navigation",
            path: "/search?q=shoes",
            label: "Search catalog",
            requiresConfirmation: true,
          }],
        },
      }),
    );

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await typeAssistantMessage("Show me shoes");
    await click(queryButton("Send storefront assistant message"));
    await flushReact();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/search?q=shoes");
    expect(document.body.textContent).toContain("Opening catalog");
    expect(window.sessionStorage.getItem(
      STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY,
    )).toContain("Show me shoes");
  });

  it("supports keyboard positioning, structural docking, sizing, and focus return", async () => {
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
    expect(panel?.tagName).toBe("ASIDE");
    expect(panel?.hasAttribute("aria-modal")).toBe(false);
    expect(document.activeElement).toBe(
      document.querySelector(
        'textarea[aria-label="Message storefront assistant"]',
      ),
    );

    await click(queryButton("Dock on the right"));
    expect(panel?.dataset.mode).toBe("docked");
    expect(panel?.dataset.side).toBe("end");
    expect(panel?.hasAttribute("aria-modal")).toBe(false);
    const layoutHost = document.querySelector<HTMLElement>(
      "#storefront-assistant-layout",
    );
    expect(layoutHost?.dataset.mode).toBe("docked");
    expect(layoutHost?.dataset.side).toBe("end");
    expect(
      layoutHost?.style.getPropertyValue(
        "--sc-assistant-dock-width",
      ),
    ).toBe("424px");
    const resizeHandle = document.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize assistant"]',
    );
    await keyDown(resizeHandle, "ArrowLeft");
    const dockedGeometry = JSON.parse(
      window.localStorage.getItem(ASSISTANT_GEOMETRY_STORAGE_KEY) ?? "{}",
    ) as { mode: string; panelWidth: number };
    expect(dockedGeometry.mode).toBe("dock-right");
    expect(dockedGeometry.panelWidth).toBeGreaterThan(424);
    expect(
      layoutHost?.style.getPropertyValue(
        "--sc-assistant-dock-width",
      ),
    ).toBe(`${dockedGeometry.panelWidth}px`);

    await click(queryButton("Dock on the left"));
    expect(layoutHost?.dataset.side).toBe("start");
    const leftDockWidth = JSON.parse(
      window.localStorage.getItem(ASSISTANT_GEOMETRY_STORAGE_KEY) ?? "{}",
    ) as { mode: string; panelWidth: number };
    expect(leftDockWidth.mode).toBe("dock-left");
    await keyDown(
      document.querySelector<HTMLElement>(
        '[role="separator"][aria-label="Resize assistant"]',
      ),
      "ArrowRight",
    );
    const widenedLeftDock = JSON.parse(
      window.localStorage.getItem(ASSISTANT_GEOMETRY_STORAGE_KEY) ?? "{}",
    ) as { panelWidth: number };
    expect(widenedLeftDock.panelWidth).toBeGreaterThan(
      leftDockWidth.panelWidth,
    );

    await keyDown(panel, "Escape");
    const restoredLauncher = queryButton("Open storefront assistant");
    expect(restoredLauncher).toBeTruthy();
    expect(document.activeElement).toBe(restoredLauncher);
    expect(layoutHost?.dataset.mode).toBe("collapsed");
  });

  it("uses an accessible modal sheet and makes the storefront inert on mobile", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(max-width: 767px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    });

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    const panel = document.querySelector<HTMLElement>(
      "#storefront-assistant-panel",
    );
    const page = document.querySelector<HTMLElement>(
      "#storefront-assistant-layout [data-assistant-page-slot]",
    );
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    expect(page?.hasAttribute("inert")).toBe(true);
    expect(page?.getAttribute("aria-hidden")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");

    await keyDown(panel, "Escape");
    expect(page?.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(queryButton("Open storefront assistant")).toBeTruthy();
  });

  it("restores a redacted conversation across a same-tab remount without persisting the draft", async () => {
    fetchMock.mockResolvedValue(Response.json({
      status: "ok",
      message: { role: "assistant", content: "Rice is available today." },
    }));
    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await typeAssistantMessage("Find rice");
    await click(queryButton("Send storefront assistant message"));
    await flushReact();
    await typeAssistantMessage("Unsaved buyer question");

    expect(window.sessionStorage.getItem(
      STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY,
    )).toBe("open");

    act(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    appendAssistantHost(host);
    const pageFocusTarget = document.createElement("button");
    pageFocusTarget.textContent = "Current page action";
    document.body.append(pageFocusTarget);
    pageFocusTarget.focus();
    root = createRoot(host);
    renderBubble();
    await flushReact();

    expect(document.querySelector("#storefront-assistant-panel")).toBeTruthy();
    expect(queryButton("Open storefront assistant")).toBeNull();
    expect(document.activeElement).toBe(pageFocusTarget);
    expect(document.body.textContent).toContain("Find rice");
    expect(document.body.textContent).toContain("Rice is available today.");
    expect(document.body.textContent).not.toContain("Unsaved buyer question");
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message storefront assistant"]',
      )?.value,
    ).toBe("");

    await click(queryButton("Collapse assistant"));
    expect(window.sessionStorage.getItem(
      STOREFRONT_ASSISTANT_OPEN_STATE_STORAGE_KEY,
    )).toBeNull();
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
                    pricePresentation: "exact",
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
    expect(queryButtonText("View Premium Rice")).toBeTruthy();
    expect(queryButton("Continue manually")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    await click(queryButtonText("View Premium Rice"));
    expect(navigate).toHaveBeenCalledWith("/products/rice");
  });

  it("persists ordered plain text around one-shot chat and marks sensitive pages", async () => {
    currentContext = buildStorefrontAssistantPageContext({
      path: "/payment-recovery",
      route: "/payment-recovery",
      canonicalUrl: "https://shop.example.test/payment-recovery",
      title: "Payment recovery",
      pageKind: "page",
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          message: {
            id: "live_assistant_message",
            parts: [
              { type: "text", text: "Use the secure recovery form." },
              {
                type: "navigation",
                path: "/products/rice",
                label: "Browse rice",
                requiresConfirmation: true,
              },
            ],
          },
          transcriptPersisted: true,
          transcriptEvent: {
            eventId: "event_assistant_2",
            sequence: 2,
            type: "message.appended",
            occurredAt: 2,
            message: {
              id: "durable_assistant_2",
              role: "assistant",
              content: "Sensitive page conversation was intentionally omitted.",
              contextMarker: "storefront:sensitive",
              createdAt: 2,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await typeAssistantMessage("Help with my payment");
    await click(queryButton("Send storefront assistant message"));
    await flushReact();

    expect(transcriptMocks.appendMessage).toHaveBeenCalledTimes(1);
    expect(transcriptMocks.appendMessage).toHaveBeenNthCalledWith(1, {
      clientMessageId: expect.stringMatching(/^message_[A-Za-z0-9_-]{22}$/),
      role: "user",
      content: "Help with my payment",
      contextMarker: "storefront:sensitive",
    });
    expect(
      transcriptMocks.appendMessage.mock.invocationCallOrder[0],
    ).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
    expect(document.body.textContent).toContain("Use the secure recovery form.");
    expect(queryButton("Browse rice")).toBeTruthy();
    expect(document.querySelector(
      '[data-assistant-transcript-state="connected"]',
    )).toBeTruthy();
  });

  it("never persists an assistant-only turn when the user transcript append fails", async () => {
    transcriptMocks.appendMessage.mockResolvedValueOnce(null);
    fetchMock.mockResolvedValue(Response.json({
      status: "ok",
      message: { role: "assistant", content: "Live-only answer." },
    }));

    renderBubble();
    await click(queryButton("Open storefront assistant"));
    await typeAssistantMessage("Continue after expiry");
    await click(queryButton("Send storefront assistant message"));
    await flushReact();

    expect(transcriptMocks.appendMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/assistant/chat");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "omit",
    });
    expect(document.body.textContent).toContain("Live-only answer.");
    expect(document.body.textContent).toContain("This reply is live-only");
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

function queryButtonText(text: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.includes(text)) ?? null;
}

function appendAssistantHost(host: HTMLDivElement) {
  let layout = document.querySelector<HTMLElement>(
    "#storefront-assistant-layout",
  );
  if (!layout) {
    layout = document.createElement("div");
    layout.id = "storefront-assistant-layout";
    layout.dataset.mode = "collapsed";
    layout.dataset.side = "end";
    layout.dataset.mobile = "false";
    const page = document.createElement("div");
    page.dataset.assistantPageSlot = "";
    const dock = document.createElement("div");
    dock.dataset.assistantDockSlot = "";
    layout.append(page, dock);
    document.body.append(layout);
  }
  layout.querySelector<HTMLElement>("[data-assistant-dock-slot]")?.append(host);
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
