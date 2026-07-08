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
    vi.restoreAllMocks();
  });

  it("renders an accessible header trigger and right-sheet controls", async () => {
    renderLauncher();

    const trigger = queryButton("Open admin assistant");
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    await click(trigger);

    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Admin assistant");
    expect(queryButton("Close admin assistant")).toBeTruthy();
    expect(queryButton("Send assistant message")).toBeTruthy();
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message admin assistant"]',
      ),
    ).toBeTruthy();
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

async function click(element: HTMLElement | null) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
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
