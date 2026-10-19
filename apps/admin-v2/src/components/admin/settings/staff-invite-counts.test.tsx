// @vitest-environment happy-dom

// Inviting staff gives them their role at once: the Roles card's "N staff"
// reads again after an invite, so a role never stays at "0 staff".
import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const rbac = vi.hoisted(() => ({ getRbacRoles: vi.fn(), getAdminUsers: vi.fn(async () => []) }));
vi.mock("~/lib/api-query-options/rbac", () => rbac);
vi.mock("@scalius/api-client/sdk", () => ({ postApiV1AdminAuthUsers: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params: _params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: unknown; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouteContext: () => ({ user: { id: "owner" } }),
  useRouter: () => ({ invalidate: vi.fn() }),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { RolesCard, afterStaffInvited } from "./UsersSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const packer = (staffCount: number) => ({
  id: "role_packer", name: "packer", displayName: "Packer", description: null, isSystem: false, permissions: ["orders.view"], staffCount,
});

describe("a role's staff count", () => {
  it("counts a person as soon as they are invited", async () => {
    rbac.getRbacRoles.mockResolvedValueOnce([packer(0)]).mockResolvedValue([packer(1)]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <QueryClientProvider client={client}><PermissionProvider isSuperAdmin><RolesCard /></PermissionProvider></QueryClientProvider>,
    ));
    await vi.waitFor(() => expect(container.textContent).toContain("0 staff"));

    // The add-staff form's success path.
    await act(async () => { await afterStaffInvited(client); });
    await vi.waitFor(() => expect(container.textContent).toContain("1 staff"));
    act(() => root.unmount());
    container.remove();
  });
});
