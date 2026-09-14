// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FraudCheckerSettings } from "./FraudCheckerSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const permissionState = vi.hoisted(() => ({ canEdit: true }));

vi.mock("~/lib/api-functions/fraud-checker", () => ({
  createFraudCheckerProvider: vi.fn(),
  updateFraudCheckerProvider: vi.fn(),
  deleteFraudCheckerProvider: vi.fn(),
  testFraudCheckerProvider: vi.fn(),
}));
vi.mock("~/contexts/PermissionContext", () => ({
  usePermissions: () => ({ hasPermission: () => permissionState.canEdit }),
}));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle", proceed: vi.fn(), reset: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const providers = [
  {
    id: "fp_1",
    name: "FraudBD production",
    providerType: "default",
    apiUrl: "https://fraudchecker.link/api/v1/qc/",
    apiKey: "secret",
    apiSecret: null,
    userId: null,
    isActive: true,
  },
  {
    id: "fp_2",
    name: "Backup lookup",
    providerType: "default",
    apiUrl: "https://fraudchecker.link/api/v1/qc/",
    apiKey: "secret",
    apiSecret: null,
    userId: null,
    isActive: false,
  },
] as unknown as Parameters<typeof FraudCheckerSettings>[0]["providers"];

function findButton(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
}

describe("FraudCheckerSettings", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.canEdit = true;
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  function render(list: typeof providers) {
    act(() => {
      root.render(<FraudCheckerSettings providers={list} />);
    });
  }

  it("offers the empty state, not an empty table, when no provider is configured", () => {
    render([] as unknown as typeof providers);

    expect(host.querySelector('[data-testid="empty-state"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="index-table"]')).toBeNull();
    expect(host.textContent).toContain("No fraud provider");
    expect(host.textContent).toContain(
      "Checks are manual and never block checkout",
    );
    expect(findButton(host, "Add provider")).toBeDefined();
  });

  it("lists providers in the index table with readable status labels", () => {
    render(providers);

    const rows = host.querySelectorAll('[data-testid="index-table-row"]');
    expect(rows).toHaveLength(2);
    expect(host.textContent).toContain("FraudBD production");
    expect(host.textContent).toContain("Backup lookup");

    const badges = Array.from(
      host.querySelectorAll('[data-testid="status-badge"]'),
    ).map((badge) => ({
      tone: badge.getAttribute("data-tone"),
      text: badge.textContent ?? "",
    }));
    expect(
      badges.some((badge) => badge.text.includes("Active") && badge.tone === "success"),
    ).toBe(true);
    expect(
      badges.some((badge) => badge.text.includes("Inactive") && badge.tone === "neutral"),
    ).toBe(true);
    expect(
      badges.filter((badge) => badge.text.includes("Not checked this session")),
    ).toHaveLength(2);

    // Each row carries an overflow menu rather than inline action buttons.
    expect(
      host.querySelectorAll('[aria-label^="Actions for "]'),
    ).toHaveLength(2);
  });

  it("opens a provider from its row and keeps the save bar out until a draft is dirty", () => {
    render(providers);

    expect(host.querySelector('[data-testid="contextual-save-bar"]')).toBeNull();

    const firstRow = host.querySelector<HTMLElement>(
      '[data-testid="index-table-row"]',
    );
    act(() => {
      firstRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.textContent).toContain("Credentials saved");
    expect(host.textContent).toContain("Used in Orders");
    expect(host.textContent).toContain(
      "Results are shown for this browser session only",
    );
    expect(host.querySelector('[data-testid="contextual-save-bar"]')).toBeNull();
    expect(findButton(host, "Test connection")).toBeDefined();
  });

  it("hides every mutation for a read-only operator", () => {
    permissionState.canEdit = false;
    render(providers);

    expect(host.textContent).toContain("Read-only access");
    expect(findButton(host, "Add provider")).toBeUndefined();

    const firstRow = host.querySelector<HTMLElement>(
      '[data-testid="index-table-row"]',
    );
    act(() => {
      firstRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(findButton(host, "Edit")).toBeUndefined();
    expect(findButton(host, "Delete")).toBeUndefined();
    // Testing a saved connection stays available without edit rights.
    expect(findButton(host, "Test connection")).toBeDefined();
  });
});
