// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendAdminAssistantMessage: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../../../lib/api-functions/ai", () => ({
  sendAdminAssistantMessage: mocks.sendAdminAssistantMessage,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AdminAssistantLauncher", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    delete window[ADMIN_ASSISTANT_PAGE_STATE_GLOBAL];
    resetAdminAssistantPageActionsForTest();
    mocks.sendAdminAssistantMessage.mockReset();
    mocks.navigate.mockReset();

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

  it("renders a movable bubble with floating, left-docked, and right-docked controls", async () => {
    renderLauncher();

    const trigger = queryButton("Open admin assistant");
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.className).toContain("rounded-full");

    await click(trigger);

    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Admin assistant");
    expect(getAssistantPanel()?.getAttribute("data-assistant-mode")).toBe("floating");
    expect(queryButton("Move assistant")).toBeTruthy();
    expect(queryButton("Resize assistant")).toBeTruthy();
    expect(queryButton("Dock assistant left")).toBeTruthy();
    expect(queryButton("Dock assistant right")).toBeTruthy();
    expect(queryButton("Use floating assistant")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
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
    expect(queryButton("Dock assistant left")?.getAttribute("aria-pressed")).toBe(
      "true",
    );

    await click(queryButton("Dock assistant right"));
    expect(getAssistantPanel()?.getAttribute("data-assistant-mode")).toBe(
      "dock-right",
    );

    await click(queryButton("Use floating assistant"));
    expect(getAssistantPanel()?.getAttribute("data-assistant-mode")).toBe(
      "floating",
    );

    await click(queryButton("Minimize admin assistant"));
    expect(getAssistantPanel()).toBeNull();
  });

  it("supports keyboard movement, resizing, shortcut toggle, and Escape collapse", async () => {
    renderLauncher();

    const trigger = queryButton("Open admin assistant");
    const initialLeft = Number.parseInt(trigger?.style.left ?? "0", 10);
    await keyDown(trigger, "ArrowLeft");
    expect(Number.parseInt(trigger?.style.left ?? "0", 10)).toBeLessThan(initialLeft);

    await keyDown(window, "a", { altKey: true, shiftKey: true });
    expect(getAssistantPanel()).toBeTruthy();

    const panel = getAssistantPanel();
    const initialWidth = Number.parseInt(panel?.style.width ?? "0", 10);
    await keyDown(queryButton("Resize assistant"), "ArrowLeft");
    expect(Number.parseInt(panel?.style.width ?? "0", 10)).toBeLessThan(initialWidth);

    await keyDown(panel, "Escape");
    expect(getAssistantPanel()).toBeNull();
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
    expect(JSON.stringify(mocks.sendAdminAssistantMessage.mock.calls[0])).not.toContain(
      "SuperSecret123",
    );
    expect(document.body.textContent).toContain("Use the status filter first.");
  });

  it("renders the disabled adminChat state without throwing in the console", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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

  it("renders navigation actions only after the assistant returns them and navigates on click", async () => {
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: { role: "assistant", content: "Use Products to manage catalog items." },
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

    const action = queryButton("Open Products");
    expect(action).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();

    await click(action);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/admin/products" });
  });

  it("runs click-confirmed registered page actions through the browser executor", async () => {
    const handler = vi.fn(() => true);
    registerAdminAssistantPageActionHandler(
      "product-edit-form:apply_field_draft",
      handler,
    );
    mocks.sendAdminAssistantMessage.mockResolvedValue({
      status: "ok",
      message: { role: "assistant", content: "Here is the replacement description." },
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

    expect(document.body.textContent).toContain("Use Products for catalog edits.");
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
      message: { role: "assistant", content: "I can point you to safe dashboard pages." },
      usage: null,
      actions: [
        { type: "navigate", path: "https://evil.test/admin", label: "Open Evil" },
        { type: "navigate", path: "/admin/orders/123", label: "Open Order Detail" },
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

  function renderLauncher() {
    act(() => {
      root.render(<AdminAssistantLauncher />);
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
    'section[aria-label="Admin assistant"]',
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
