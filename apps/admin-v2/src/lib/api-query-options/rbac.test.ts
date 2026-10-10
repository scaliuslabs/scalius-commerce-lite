import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { roleQueryOptions } from "./rbac";
import { queryKeys } from "../query-keys";

const sdk = vi.hoisted(() => ({ detail: vi.fn(), list: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminRbacRolesById: sdk.detail,
  getApiV1AdminRbacRoles: sdk.list,
  getApiV1AdminAuthUsers: vi.fn(),
}));
vi.mock("../api", () => ({ apiData: (pending: Promise<unknown>) => pending }));

it("loads one role without enumerating the store and shares RBAC invalidation", async () => {
  const role = { id: "role-1", displayName: "Support", permissions: ["orders.view"], staffCount: 2 };
  sdk.detail.mockResolvedValue({ role });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await expect(client.ensureQueryData(roleQueryOptions(role.id))).resolves.toEqual(role);
    expect(sdk.detail).toHaveBeenCalledExactlyOnceWith({ path: { id: role.id } });
    expect(sdk.list).not.toHaveBeenCalled();
    await client.invalidateQueries({ queryKey: queryKeys.rbac.all });
    expect(client.getQueryState(queryKeys.rbac.role(role.id))?.isInvalidated).toBe(true);
  } finally {
    client.clear();
  }
});
