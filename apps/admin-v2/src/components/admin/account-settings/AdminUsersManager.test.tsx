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
      suspendedSection()?.querySelector("summary span.rounded-full")?.textContent,
    );
  }

  function normalizeText(value: string | null | undefined) {
    return value?.replace(/\s+/g, " ").trim() ?? "";
  }

  function headerCount() {
    const title = Array.from(host.querySelectorAll("*")).find(
      (node) => node.childNodes.length > 1 && normalizeText(node.textContent).startsWith("Administrators"),
    );
    return normalizeText(title?.querySelector("span.rounded-full")?.textContent);
  }

  function setSearch(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Find administrators"]');
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
