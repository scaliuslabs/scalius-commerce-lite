// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendAdminAssistantMessage: vi.fn(),
  navigate: vi.fn(),
  appendConversationMessage: vi.fn(),
  createConversationId: vi.fn(),
  createConversationRequestId: vi.fn(),
  isConversationId: vi.fn(),
  pollConversationEvents: vi.fn(),
  readConversationEvents: vi.fn(),
  requestSequence: 0,
  eventSequence: 0,
}));

vi.mock("../../../lib/api-functions/ai", () => ({
  sendAdminAssistantMessage: mocks.sendAdminAssistantMessage,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("../../../lib/admin-assistant-conversation", () => ({
  appendAdminConversationMessage: mocks.appendConversationMessage,
  createAdminConversationId: mocks.createConversationId,
  createAdminConversationRequestId: mocks.createConversationRequestId,
  isAdminConversationId: mocks.isConversationId,
  pollAdminConversationEvents: mocks.pollConversationEvents,
  readAdminConversationEvents: mocks.readConversationEvents,
}));

import { AdminAssistantLauncher } from "./AdminAssistantLauncher";
import {
  registerAdminAssistantPageActionHandler,
  resetAdminAssistantPageActionsForTest,
} from "./page-actions";
import {
  ADMIN_ASSISTANT_PAGE_STATE_GLOBAL,
  type AdminAssistantPageStateSnapshot,
} from "./page-state";
import { ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY } from "./admin-assistant-transcript";
import { ADMIN_NAVIGATION_CANCELLED_EVENT } from "../shared/admin-navigation-events";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("AdminAssistantLauncher", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";
    setViewportWidth(1024);
    window.sessionStorage.clear();
    delete window[ADMIN_ASSISTANT_PAGE_STATE_GLOBAL];
    resetAdminAssistantPageActionsForTest();
    mocks.sendAdminAssistantMessage.mockReset();
    mocks.navigate.mockReset();
    mocks.appendConversationMessage.mockReset();
    mocks.createConversationId.mockReset();
    mocks.createConversationRequestId.mockReset();
    mocks.isConversationId.mockReset();
    mocks.pollConversationEvents.mockReset();
    mocks.readConversationEvents.mockReset();
    mocks.requestSequence = 0;
    mocks.eventSequence = 0;
    mocks.createConversationId.mockReturnValue("conv_abcdefghijklmnopqrstuv");
    mocks.createConversationRequestId.mockImplementation(
      (purpose = "message") => {
        mocks.requestSequence += 1;
        return `${purpose}_${String(mocks.requestSequence).padStart(22, "a")}`;
      },
    );
    mocks.isConversationId.mockImplementation((value: string) =>
      /^conv_[A-Za-z0-9_-]{22,64}$/.test(value),
    );
    mocks.readConversationEvents.mockResolvedValue(emptyReplay());
    mocks.appendConversationMessage.mockImplementation(
      async (_conversationId: string, input: ConversationAppendInput) => {
        mocks.eventSequence += 1;
        const event = conversationMessageEvent(
          mocks.eventSequence,
          input.role,
          input.content,
          input.contextMarker,
        );
        return {
          replayed: false,
          event,
          expiresAt: 1_725_604_800_000,
        };
      },
    );
    mocks.pollConversationEvents.mockImplementation(
      ({ after = 0, signal }: { after?: number; signal: AbortSignal }) =>
        new Promise<number>((resolve) => {
          if (signal.aborted) {
            resolve(after);
            return;
          }
          signal.addEventListener("abort", () => resolve(after), {
            once: true,
          });
        }),
    );

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete window[ADMIN_ASSISTANT_PAGE_STATE_GLOBAL];
    resetAdminAssistantPageActionsForTest();
    vi.restoreAllMocks();
  });

  it("renders floating and real left/right workspace columns without portals", async () => {
    renderLauncher();

    expect(getAssistantWorkspace()?.dataset.mode).toBe("closed");
    expect(getAssistantDockSlot()?.hidden).toBe(true);
    const trigger = queryButton("Open admin assistant");
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.className).toContain("rounded-full");

    await click(trigger);

    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Admin assistant");
    expect(getAssistantPanel()?.tagName).toBe("ASIDE");
    expect(getAssistantPanel()?.getAttribute("data-assistant-mode")).toBe(
      "floating",
    );
    expect(queryButton("Move assistant")).toBeTruthy();
    expect(queryButton("Resize assistant")).toBeTruthy();
    expect(queryButton("Dock assistant left")).toBeTruthy();
    expect(queryButton("Dock assistant right")).toBeTruthy();
    expect(
      queryButton("Use floating assistant")?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(queryButton("Minimize admin assistant")).toBeTruthy();
    expect(queryButton("Send assistant message")).toBeTruthy();
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message admin assistant"]',
      ),
    ).toBeTruthy();

    await click(queryButton("Dock assistant left"));
    expect(getAssistantPanel()?.getAttribute("data-assistant-mode")).toBe(
      "dock-left",
    );
    expect(getAssistantWorkspace()?.dataset.mode).toBe("docked");
    expect(getAssistantWorkspace()?.dataset.side).toBe("start");
    expect(getAssistantPanel()?.closest("[data-assistant-dock-slot]")).toBe(
      getAssistantDockSlot(),
    );
    expect(getAssistantDockSlot()?.hidden).toBe(false);
    expect(
      queryButton("Dock assistant left")?.getAttribute("aria-pressed"),
    ).toBe("true");

    await click(queryButton("Dock assistant right"));
    expect(getAssistantPanel()?.getAttribute("data-assistant-mode")).toBe(
      "dock-right",
    );
    expect(getAssistantWorkspace()?.dataset.mode).toBe("docked");
    expect(getAssistantWorkspace()?.dataset.side).toBe("end");
    expect(getAssistantPanel()?.closest("[data-assistant-dock-slot]")).toBe(
      getAssistantDockSlot(),
    );

    await click(queryButton("Use floating assistant"));
    expect(getAssistantPanel()?.getAttribute("data-assistant-mode")).toBe(
      "floating",
    );

    await click(queryButton("Minimize admin assistant"));
    expect(getAssistantPanel()).toBeNull();
    expect(getAssistantWorkspace()?.dataset.mode).toBe("closed");
    expect(getAssistantDockSlot()?.hidden).toBe(true);
  });

  it("keeps the assistant mounted when only routed workspace content changes", async () => {
    renderLauncher(<section data-route-content="">Products route</section>);
    await click(queryButton("Open admin assistant"));
    await click(queryButton("Dock assistant right"));

    const panelBeforeRouteChange = getAssistantPanel();
    expect(panelBeforeRouteChange).toBeTruthy();
    expect(getAssistantWorkspace()?.dataset.mode).toBe("docked");

    renderLauncher(<section data-route-content="">Orders route</section>);
    await flushReact();

    expect(getAssistantPanel()).toBe(panelBeforeRouteChange);
    expect(getAssistantWorkspace()?.dataset.mode).toBe("docked");
    expect(
      document.querySelector("[data-assistant-page-slot]")?.textContent,
    ).toContain("Orders route");
    expect(
      document.querySelector("[data-assistant-page-slot]")?.textContent,
    ).not.toContain("Products route");
  });

  it("supports keyboard movement, resizing, shortcut toggle, and Escape collapse", async () => {
    renderLauncher();

    const trigger = queryButton("Open admin assistant");
    const initialLeft = Number.parseInt(trigger?.style.left ?? "0", 10);
    await keyDown(trigger, "ArrowLeft");
    expect(Number.parseInt(trigger?.style.left ?? "0", 10)).toBeLessThan(
      initialLeft,
    );

    await keyDown(window, "a", { altKey: true, shiftKey: true });
    expect(getAssistantPanel()).toBeTruthy();

    const panel = getAssistantPanel();
    const initialWidth = Number.parseInt(panel?.style.width ?? "0", 10);
    await keyDown(queryButton("Resize assistant"), "ArrowLeft");
    expect(Number.parseInt(panel?.style.width ?? "0", 10)).toBeLessThan(
      initialWidth,
    );

    await keyDown(panel, "Escape");
    expect(getAssistantPanel()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses a complete mobile dialog boundary and never leaves an inert page behind", async () => {
    setViewportWidth(390);
    renderLauncher(<button>Page action</button>);

    const trigger = queryButton("Open admin assistant");
    trigger?.focus();
    await click(trigger);
    await nextMacrotask();

    const workspace = getAssistantWorkspace();
    const page = document.querySelector<HTMLElement>(
      "[data-assistant-page-slot]",
    );
    const dialog = document.querySelector<HTMLElement>(
      '[data-assistant-modal-boundary][role="dialog"]',
    );
    expect(workspace?.dataset.mobile).toBe("true");
    expect(page?.hasAttribute("inert")).toBe(true);
    expect(page?.getAttribute("aria-hidden")).toBe("true");
    expect(dialog?.getAttribute("aria-label")).toBe("Admin assistant");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.contains(getAssistantPanel())).toBe(true);
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overflow).toBe("hidden");

    await click(queryButton("Minimize admin assistant"));
    await nextMacrotask();
    expect(
      document.querySelector('[data-assistant-modal-boundary][role="dialog"]'),
    ).toBeNull();
    expect(page?.hasAttribute("inert")).toBe(false);
    expect(page?.hasAttribute("aria-hidden")).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);

    await click(trigger);
    const reopenedDialog = document.querySelector<HTMLElement>(
      '[data-assistant-modal-boundary][role="dialog"]',
    );
    expect(page?.hasAttribute("inert")).toBe(Boolean(reopenedDialog));
    await keyDown(reopenedDialog, "Escape");
    await nextMacrotask();
    expect(page?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("sends only the typed message and sanitized page-state context", async () => {
    const pageState: AdminAssistantPageStateSnapshot = {
      version: 1,
      routePath: "/admin/orders/[redacted-token]",
      pageTitle: "Orders",
      pageHeading: "Order [redacted-number]",
      mainScroll: {
        top: 0,
        maxTop: 0,
        viewportHeight: 600,
        contentHeight: 600,
        atTop: true,
        atBottom: true,
      },
      surfaces: [
        {
          id: "orders-table",
          kind: "table",
          label: "Orders",
          rowCount: 12,
          selectedCount: 1,
        },
      ],
    };
    window[ADMIN_ASSISTANT_PAGE_STATE_GLOBAL] = pageState;
    const hiddenInput = document.createElement("input");
    hiddenInput.value = "SuperSecret123";
    document.body.append(hiddenInput);
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: { role: "assistant", content: "Use the status filter first." },
      usage: null,
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("What should I check here?");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(mocks.sendAdminAssistantMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminAssistantMessage).toHaveBeenCalledWith({
      data: {
        message: "What should I check here?",
        pageContext: pageState,
        history: [],
      },
    });
    expect(
      JSON.stringify(mocks.sendAdminAssistantMessage.mock.calls[0]),
    ).not.toContain("SuperSecret123");
    expect(mocks.appendConversationMessage).toHaveBeenCalledTimes(2);
    expect(mocks.appendConversationMessage).toHaveBeenNthCalledWith(
      1,
      "conv_abcdefghijklmnopqrstuv",
      {
        clientMessageId: expect.stringMatching(/^message_[A-Za-z0-9_-]{22}$/),
        role: "user",
        content: "What should I check here?",
        contextMarker: "admin:sensitive",
      },
    );
    expect(mocks.appendConversationMessage).toHaveBeenNthCalledWith(
      2,
      "conv_abcdefghijklmnopqrstuv",
      {
        clientMessageId: expect.stringMatching(/^message_[A-Za-z0-9_-]{22}$/),
        role: "assistant",
        content: "Use the status filter first.",
        contextMarker: "admin:sensitive",
      },
    );
    expect(
      mocks.appendConversationMessage.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.sendAdminAssistantMessage.mock.invocationCallOrder[0]);
    expect(
      mocks.sendAdminAssistantMessage.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.appendConversationMessage.mock.invocationCallOrder[1]);
    expect(document.body.textContent).toContain("Use the status filter first.");
  });

  it("hydrates ordered messages once, reconciles replay duplicates, and polls from the cursor", async () => {
    mocks.readConversationEvents.mockResolvedValue({
      ...emptyReplay(),
      events: [
        conversationMessageEvent(2, "assistant", "Second", "admin:page"),
        conversationMessageEvent(1, "user", "First", "admin:page"),
        conversationMessageEvent(2, "assistant", "Second", "admin:page"),
      ],
      cursor: 2,
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await flushReact();

    const messages = Array.from(
      document.querySelectorAll<HTMLElement>("[data-assistant-message-role]"),
    );
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.textContent)).toEqual([
      "First",
      "Second",
    ]);
    expect(mocks.readConversationEvents).toHaveBeenCalledWith(
      "conv_abcdefghijklmnopqrstuv",
      expect.objectContaining({ after: 0, limit: 100 }),
    );
    expect(mocks.pollConversationEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv_abcdefghijklmnopqrstuv",
        after: 2,
        limit: 100,
      }),
    );
    expect(
      window.sessionStorage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      ),
    ).toBe("conv_abcdefghijklmnopqrstuv");
    expect(window.sessionStorage.length).toBe(1);
    expect(
      document.querySelector('[data-assistant-transcript-state="connected"]'),
    ).toBeTruthy();
  });

  it("continues one-shot chat when transcript append fails and offers an accessible retry", async () => {
    mocks.appendConversationMessage.mockRejectedValueOnce(
      new Error("transcript unavailable"),
    );
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: {
        role: "assistant",
        content: "You can still use this response.",
      },
      usage: null,
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Help me anyway");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(mocks.sendAdminAssistantMessage).toHaveBeenCalledTimes(1);
    expect(mocks.appendConversationMessage).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "You can still use this response.",
    );
    expect(
      document.querySelector(
        '[data-assistant-transcript-state="disconnected"]',
      ),
    ).toBeTruthy();
    expect(queryButton("Retry transcript connection")).toBeTruthy();

    await click(queryButton("Retry transcript connection"));
    expect(mocks.readConversationEvents).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector('[data-assistant-transcript-state="connected"]'),
    ).toBeTruthy();
  });

  it("persists assistant text only and truthfully loses live actions after reload", async () => {
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: {
        role: "assistant",
        content: "Use Products to manage catalog items.",
        parts: [
          { type: "text", text: "Use Products to manage catalog items." },
        ],
      },
      usage: null,
      actions: [
        { type: "navigate", path: "/admin/products", label: "Open Products" },
      ],
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Where do I manage products?");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(queryButton("Open Products")).toBeTruthy();
    const persistedAssistantInput =
      mocks.appendConversationMessage.mock.calls[1]?.[1];
    expect(persistedAssistantInput).toEqual({
      clientMessageId: expect.stringMatching(/^message_[A-Za-z0-9_-]{22}$/),
      role: "assistant",
      content: "Use Products to manage catalog items.",
      contextMarker: "admin:page",
    });
    expect(persistedAssistantInput).not.toHaveProperty("parts");
    expect(persistedAssistantInput).not.toHaveProperty("actions");

    act(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    mocks.readConversationEvents.mockResolvedValue({
      ...emptyReplay(),
      events: [
        conversationMessageEvent(
          1,
          "user",
          "Where do I manage products?",
          "admin:page",
        ),
        conversationMessageEvent(
          2,
          "assistant",
          "Use Products to manage catalog items.",
          "admin:page",
        ),
      ],
      cursor: 2,
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await flushReact();

    expect(document.body.textContent).toContain(
      "Use Products to manage catalog items.",
    );
    expect(queryButton("Open Products")).toBeNull();
  });

  it("renders the disabled adminChat state without throwing in the console", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "disabled",
      reason: "unconfigured",
      message: "Admin chat is not ready. Save a valid provider key first.",
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Can you help?");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(document.body.textContent).toContain("Admin chat is not ready.");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps advisory navigation click-confirmed", async () => {
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: {
        role: "assistant",
        content: "Use Products to manage catalog items.",
      },
      usage: null,
      actions: [
        { type: "navigate", path: "/admin/products", label: "Open Products" },
      ],
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Where do I manage products?");
    await click(queryButton("Send assistant message"));
    await flushReact();

    const action = queryButton("Open Products");
    expect(action).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();

    await click(action);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/admin/products" });
  });

  it("navigates immediately for an unambiguous user-confirmed destination", async () => {
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: {
        role: "assistant",
        content: "Use the visible Products action to continue.",
      },
      usage: null,
      actions: [
        { type: "navigate", path: "/admin/products", label: "Open Products" },
      ],
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Can you take me to products page?");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/admin/products" });
    expect(document.body.textContent).toContain("Opening Products");
    expect(queryButton("Open Products")?.disabled).toBe(true);
  });

  it("does not keep the composer busy while a dirty-form blocker holds navigation", async () => {
    mocks.navigate.mockReturnValue(new Promise<void>(() => {}));
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: { role: "assistant", content: "Opening Products." },
      usage: null,
      actions: [
        { type: "navigate", path: "/admin/products", label: "Open Products" },
      ],
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Open products");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/admin/products" });
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message admin assistant"]',
      )?.disabled,
    ).toBe(false);
    expect(queryButton("Open Products")?.disabled).toBe(true);

    window.dispatchEvent(new Event(ADMIN_NAVIGATION_CANCELLED_EVENT));
    await flushReact();

    expect(document.querySelector("[data-assistant-status]")).toBeNull();
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message admin assistant"]',
      )?.disabled,
    ).toBe(false);
  });

  it("runs click-confirmed registered page actions through the browser executor", async () => {
    const handler = vi.fn(() => true);
    registerAdminAssistantPageActionHandler(
      "product-edit-form:apply_field_draft",
      handler,
    );
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: {
        role: "assistant",
        content: "Here is the replacement description.",
      },
      usage: null,
      actions: [
        {
          type: "apply_field_draft",
          id: "product-edit-form:apply_field_draft",
          targetId: "product-edit-form",
          label: "Apply to description",
          fieldName: "description",
          value: "<p>Here is the replacement description.</p>",
        },
      ],
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Improve this product description");
    await click(queryButton("Send assistant message"));
    await flushReact();

    const action = queryButton("Apply to description");
    expect(action).toBeTruthy();
    expect(handler).not.toHaveBeenCalled();

    await click(action);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "apply_field_draft",
        id: "product-edit-form:apply_field_draft",
        targetId: "product-edit-form",
        fieldName: "description",
        value: "<p>Here is the replacement description.</p>",
      }),
    );
    expect(action?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Draft applied to the visible form. Review it before saving.",
    );

    await click(action);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reports a registered form save only after the handler confirms success", async () => {
    const handler = vi.fn(async () => true);
    registerAdminAssistantPageActionHandler(
      "product-edit:prod_one:instance-a:save_registered_form",
      handler,
    );
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: { role: "assistant", content: "The form is ready to save." },
      usage: null,
      actions: [
        {
          type: "save_registered_form",
          id: "product-edit:prod_one:instance-a:save_registered_form",
          targetId: "product-edit:prod_one:instance-a",
          label: "Save visible form",
        },
      ],
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Save this product");
    await click(queryButton("Send assistant message"));
    await flushReact();

    const action = queryButton("Save visible form");
    await click(action);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(action?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Visible form saved successfully.",
    );
  });

  it("reports a failed registered save without claiming the form changed", async () => {
    const handler = vi.fn(async () => false);
    registerAdminAssistantPageActionHandler(
      "product-edit:prod_one:instance-a:save_registered_form",
      handler,
    );
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: { role: "assistant", content: "The form is ready to save." },
      usage: null,
      actions: [
        {
          type: "save_registered_form",
          id: "product-edit:prod_one:instance-a:save_registered_form",
          targetId: "product-edit:prod_one:instance-a",
          label: "Save visible form",
        },
      ],
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Save this product");
    await click(queryButton("Send assistant message"));
    await flushReact();

    const action = queryButton("Save visible form");
    await click(action);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(action?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "The visible form was not saved. Review the page error, then request a new save action.",
    );
    expect(document.body.textContent).not.toContain(
      "Visible form saved successfully.",
    );
  });

  it("renders assistant markdown as chat typography instead of raw syntax", async () => {
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: {
        role: "assistant",
        content:
          "Use **Products** for catalog edits.\n\n1. Open `Products`.\n2. Save after reviewing.",
      },
      usage: null,
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("How do I edit products?");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(document.body.textContent).toContain(
      "Use Products for catalog edits.",
    );
    expect(document.body.textContent).toContain("Open Products.");
    expect(document.body.textContent).not.toContain("**Products**");
    expect(document.body.textContent).not.toContain("`Products`");
    expect(document.querySelector("strong")?.textContent).toBe("Products");
    expect(document.querySelector("code")?.textContent).toBe("Products");
    expect(document.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("drops unsafe navigation actions before rendering buttons", async () => {
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: {
        role: "assistant",
        content: "I can point you to safe dashboard pages.",
      },
      usage: null,
      actions: [
        {
          type: "navigate",
          path: "https://evil.test/admin",
          label: "Open Evil",
        },
        {
          type: "navigate",
          path: "/admin/orders/123",
          label: "Open Order Detail",
        },
      ],
    });

    renderLauncher();
    await click(queryButton("Open admin assistant"));
    await typeAssistantMessage("Open that order");
    await click(queryButton("Send assistant message"));
    await flushReact();

    expect(queryButton("Open Evil")).toBeNull();
    expect(queryButton("Open Order Detail")).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  function renderLauncher(children?: ReactNode) {
    act(() => {
      root.render(<AdminAssistantLauncher>{children}</AdminAssistantLauncher>);
    });
  }
});

function queryButton(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
}

function getAssistantPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'aside[aria-label="Admin assistant"]',
  );
}

function getAssistantWorkspace(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-admin-assistant-workspace]",
  );
}

function getAssistantDockSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-assistant-dock-slot]");
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

async function keyDown(
  element: EventTarget | null,
  key: string,
  options: KeyboardEventInit = {},
) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
  });
  await flushReact();
}

async function typeAssistantMessage(value: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message admin assistant"]',
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
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function nextMacrotask() {
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
  await flushReact();
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

interface ConversationAppendInput {
  clientMessageId: string;
  role: "user" | "assistant";
  content: string;
  contextMarker: "admin:page" | "admin:sensitive";
}

function conversationMessageEvent(
  sequence: number,
  role: "user" | "assistant",
  content: string,
  contextMarker: "admin:page" | "admin:sensitive",
) {
  return {
    eventId: `event_${sequence}`,
    sequence,
    type: "message.appended" as const,
    occurredAt: 1_725_000_000_000 + sequence,
    message: {
      id: `message_${sequence}`,
      role,
      content,
      contextMarker,
      createdAt: 1_725_000_000_000 + sequence,
    },
  };
}

function emptyReplay() {
  return {
    events: [],
    cursor: 0,
    earliestCursor: 0,
    hasMore: false,
    expiresAt: 1_725_604_800_000,
    cancellation: null,
  };
}
