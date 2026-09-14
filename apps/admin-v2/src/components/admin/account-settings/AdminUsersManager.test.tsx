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
} from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { PermissionProvider } from "~/contexts/PermissionContext";

import { AdminUsersManager } from "./AdminUsersManager";
import type { AdminUser } from "./hooks/useAdminUsers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const hookState = vi.hoisted(() => ({
  adminUsers: [] as unknown[],
  updateSuspension: vi.fn(),
}));

vi.mock("./hooks/useAdminUsers", () => ({
  useAdminUsers: () => ({
    adminUsers: hookState.adminUsers,
    availableRoles: [],
    isLoading: false,
    isLoadingRoles: false,
    usersError: null,
    rolesError: null,
    addUser: vi.fn(),
    deleteUser: vi.fn(),
    resendSetup: vi.fn(),
    updateSuspension: hookState.updateSuspension,
    refetch: vi.fn(),
    refetchRoles: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("../UserPermissionEditor", () => ({
  UserPermissionEditor: () => null,
}));

const CURRENT_USER_ID = "user_owner";

function makeUser(overrides: Partial<AdminUser> & { id: string; name: string }): AdminUser {
  return {
    email: `${overrides.id}@example.com`,
    emailVerified: true,
    image: null,
    twoFactorEnabled: true,
    mustChangePassword: false,
    mustEnrollTwoFactor: false,
    suspended: false,
    invitation: null,
    isSuperAdmin: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    roles: [{ id: "role_manager", name: "manager", displayName: "Manager" }],
    rolesTruncated: false,
    overrides: { grants: [], denials: [] },
    overridesTruncated: false,
    ...overrides,
  };
}

const owner = makeUser({ id: CURRENT_USER_ID, name: "Store Owner" });
const readyAdmin = makeUser({ id: "user_ready", name: "Ready Admin" });
const invitedAdmin = makeUser({
  id: "user_invited",
  name: "Invited Admin",
  twoFactorEnabled: false,
  mustChangePassword: true,
  mustEnrollTwoFactor: true,
  invitation: { status: "pending", expiresAt: null, lastSentAt: null },
});
const suspendedAdmin = makeUser({
  id: "user_suspended",
  name: "Nadia Suspended",
  email: "nadia@example.com",
  suspended: true,
  roles: [{ id: "role_support", name: "support", displayName: "Support" }],
});

describe("AdminUsersManager suspended section", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    hookState.adminUsers = [owner, readyAdmin, invitedAdmin, suspendedAdmin];
    hookState.updateSuspension.mockReset();
    hookState.updateSuspension.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  function render() {
    act(() => {
      root.render(
        <PermissionProvider permissions={[PERMISSIONS.TEAM_MANAGE]}>
          <AdminUsersManager currentUserId={CURRENT_USER_ID} />
        </PermissionProvider>,
      );
    });
  }

  function activeList() {
    return host.querySelector<HTMLElement>('[data-admin-list="active"]');
  }

  function suspendedSection() {
    return host.querySelector<HTMLDetailsElement>('details[data-admin-list="suspended"]');
  }

  function suspendedCount() {
    return normalizeText(
      suspendedSection()?.querySelector('[data-testid="suspended-users-count"]')
        ?.textContent,
    );
  }

  function normalizeText(value: string | null | undefined) {
    return value?.replace(/\s+/g, " ").trim() ?? "";
  }

  function headerCount() {
    return normalizeText(
      host.querySelector('[data-testid="admin-users-count"]')?.textContent,
    );
  }



  function setSearch(value: string) {
    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="index-filters-search"]',
    );
    if (!input) throw new Error("Expected the administrator search input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }


  function click(element: Element) {
    act(() => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  async function flushReactUpdates() {
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("moves suspended administrators out of the main list into the Suspended section", () => {
    render();

    const main = activeList();
    const suspended = suspendedSection();
    expect(main).not.toBeNull();
    expect(suspended).not.toBeNull();

    expect(main?.textContent).toContain("Store Owner");
    expect(main?.textContent).toContain("Ready Admin");
    expect(main?.textContent).toContain("Invited Admin");
    expect(main?.textContent).toContain("Invite pending");
    expect(main?.textContent).not.toContain("Nadia Suspended");

    expect(suspended?.textContent).toContain("Nadia Suspended");
    expect(suspended?.textContent).not.toContain("Ready Admin");
    expect(suspended?.open).toBe(false);
    expect(normalizeText(suspended?.querySelector("summary")?.textContent)).toContain("Suspended");
    expect(suspendedCount()).toBe("1");
  });

  it("counts only non-suspended administrators in the main heading", () => {
    render();

    expect(headerCount()).toBe("3");
  });

  it("omits the Suspended section when nobody is suspended", () => {
    hookState.adminUsers = [owner, readyAdmin];
    render();

    expect(suspendedSection()).toBeNull();
    expect(headerCount()).toBe("2");
  });

  it("reveals a suspended administrator when the search matches them", () => {
    render();

    setSearch("nadia");

    const suspended = suspendedSection();
    expect(suspended?.open).toBe(true);
    expect(suspended?.textContent).toContain("Nadia Suspended");
    expect(suspendedCount()).toBe("1 of 1");
    expect(activeList()?.textContent).toContain("No active administrators match");
    expect(host.textContent).not.toContain("No matching administrators");
  });

  it("keeps the search working for the main list and reports no matches across both", () => {
    render();

    setSearch("user_ready@");
    expect(activeList()?.textContent).toContain("Ready Admin");
    expect(activeList()?.textContent).not.toContain("Store Owner");
    expect(suspendedSection()?.textContent).toContain("No suspended administrators match this search.");

    setSearch("zzz-nobody");
    expect(host.textContent).toContain("No matching administrators");
    expect(activeList()).toBeNull();
  });

  it("restores access from the Suspended section", async () => {
    render();

    const restoreButton = Array.from(
      suspendedSection()?.querySelectorAll("button") ?? [],
    ).find((button) => normalizeText(button.textContent).includes("Restore access"));
    if (!restoreButton) throw new Error("Expected a Restore access button in the Suspended section");
    expect(activeList()?.textContent).not.toContain("Restore access");

    click(restoreButton);
    await flushReactUpdates();

    expect(hookState.updateSuspension).toHaveBeenCalledTimes(1);
    expect(hookState.updateSuspension).toHaveBeenCalledWith(suspendedAdmin.id, false);
  });
});

describe("AdminUsersManager index table", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    hookState.adminUsers = [owner, readyAdmin, invitedAdmin, suspendedAdmin];
    hookState.updateSuspension.mockReset();
    hookState.updateSuspension.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  function render() {
    act(() => {
      root.render(
        <PermissionProvider permissions={[PERMISSIONS.TEAM_MANAGE]}>
          <AdminUsersManager currentUserId={CURRENT_USER_ID} />
        </PermissionProvider>,
      );
    });
  }

  function normalizeText(value: string | null | undefined) {
    return value?.replace(/\s+/g, " ").trim() ?? "";
  }

  function activeList() {
    return host.querySelector<HTMLElement>('[data-admin-list="active"]');
  }

  function suspendedSection() {
    return host.querySelector<HTMLDetailsElement>('details[data-admin-list="suspended"]');
  }

  function rowIds(scope: HTMLElement | null) {
    return Array.from(
      scope?.querySelectorAll<HTMLElement>('[data-testid="index-table-row"]') ?? [],
    ).map((row) => row.getAttribute("data-row-id") ?? "");
  }

  function setSearch(value: string) {
    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="index-filters-search"]',
    );
    if (!input) throw new Error("Expected the administrator search input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function clickPill(id: string) {
    const pill = host.querySelector<HTMLButtonElement>(
      `[data-testid="index-filters-pill-${id}"]`,
    );
    if (!pill) throw new Error(`Expected the "${id}" status pill`);
    act(() => {
      pill.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  it("lists every non-suspended administrator as one index-table row", () => {
    render();

    const table = activeList()?.querySelector("table");
    expect(table?.getAttribute("aria-label")).toBe("Active administrators");
    expect(rowIds(activeList())).toEqual([
      CURRENT_USER_ID,
      readyAdmin.id,
      invitedAdmin.id,
    ]);

    const firstRow = activeList()?.querySelector<HTMLElement>(
      '[data-testid="index-table-row"]',
    );
    expect(normalizeText(firstRow?.textContent)).toContain("Store Owner");
    expect(normalizeText(firstRow?.textContent)).toContain("Manager");
    expect(firstRow?.querySelector('[data-testid="status-badge"]')).not.toBeNull();
  });

  it("labels each row status with a toned StatusBadge instead of an ad hoc pill", () => {
    render();

    const badgeFor = (id: string) =>
      host
        .querySelector<HTMLElement>(`[data-row-id="${id}"]`)
        ?.querySelector<HTMLElement>('[data-testid="status-badge"]');

    expect(badgeFor(readyAdmin.id)?.getAttribute("data-tone")).toBe("success");
    expect(normalizeText(badgeFor(readyAdmin.id)?.textContent)).toContain("Ready");
    expect(badgeFor(invitedAdmin.id)?.getAttribute("data-tone")).toBe("attention");
    expect(normalizeText(badgeFor(invitedAdmin.id)?.textContent)).toContain(
      "Invite pending",
    );
    expect(badgeFor(suspendedAdmin.id)?.getAttribute("data-tone")).toBe("critical");
    expect(normalizeText(badgeFor(suspendedAdmin.id)?.textContent)).toContain(
      "Suspended",
    );
  });

  it("narrows the rows by search text across name, email, and role", () => {
    render();

    setSearch("Ready Admin");
    expect(rowIds(activeList())).toEqual([readyAdmin.id]);

    // The status label is searchable too, so "Ready" alone keeps both.
    setSearch("Ready");
    expect(rowIds(activeList())).toEqual([CURRENT_USER_ID, readyAdmin.id]);

    setSearch("nadia@example.com");
    expect(rowIds(activeList())).toEqual([]);
    expect(rowIds(suspendedSection())).toEqual([suspendedAdmin.id]);

    setSearch("Support");
    expect(rowIds(suspendedSection())).toEqual([suspendedAdmin.id]);

    setSearch("");
    expect(rowIds(activeList())).toHaveLength(3);
  });

  it("narrows the rows by status pill and keeps suspended users reachable and labelled", () => {
    render();

    clickPill("ready");
    expect(rowIds(activeList())).toEqual([CURRENT_USER_ID, readyAdmin.id]);
    expect(rowIds(suspendedSection())).toEqual([]);

    clickPill("setup");
    expect(rowIds(activeList())).toEqual([invitedAdmin.id]);

    clickPill("suspended");
    // The suspended disclosure opens itself so the filtered match is visible.
    expect(suspendedSection()?.open).toBe(true);
    expect(rowIds(suspendedSection())).toEqual([suspendedAdmin.id]);
    expect(
      normalizeText(
        suspendedSection()
          ?.querySelector<HTMLElement>(`[data-row-id="${suspendedAdmin.id}"]`)
          ?.textContent,
      ),
    ).toContain("Suspended");
    expect(rowIds(activeList())).toEqual([]);
    expect(normalizeText(activeList()?.textContent)).toContain(
      "No active administrators match",
    );

    clickPill("all");
    expect(rowIds(activeList())).toHaveLength(3);
  });

  it("offers a row overflow menu for per-user actions", () => {
    render();

    const readyRow = host.querySelector<HTMLElement>(
      `[data-row-id="${readyAdmin.id}"]`,
    );
    const menuTrigger = readyRow?.querySelector<HTMLButtonElement>(
      `button[aria-label="Actions for ${readyAdmin.name}"]`,
    );
    expect(menuTrigger).not.toBeNull();
    expect(menuTrigger?.getAttribute("aria-expanded")).toBe("false");

    // Your own row has no destructive self-service actions.
    expect(
      host
        .querySelector<HTMLElement>(`[data-row-id="${CURRENT_USER_ID}"]`)
        ?.querySelector('button[aria-label^="Actions for"]'),
    ).toBeNull();
  });

  it("shows an empty state instead of a table when nobody is listed", () => {
    hookState.adminUsers = [];
    render();

    expect(host.querySelector('[data-testid="index-table"]')).toBeNull();
    const empty = host.querySelector<HTMLElement>('[data-testid="empty-state"]');
    expect(normalizeText(empty?.textContent)).toContain("No administrators found");
  });
});
