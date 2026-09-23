import {
  getApiV1AdminAuthUsers,
  getApiV1AdminRbacRoles,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "../api";

export type RbacRole = ApiResult<typeof getApiV1AdminRbacRoles>["roles"][number];
export type AdminUser = ApiResult<typeof getApiV1AdminAuthUsers>["users"][number];

/** Every role; the API pages roles one at a time to bound permission enrichment. */
export async function getRbacRoles(): Promise<RbacRole[]> {
  const roles: RbacRole[] = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const result = await apiData(getApiV1AdminRbacRoles({ query: { page, limit: 1 } }));
    roles.push(...result.roles);
    if (!result.pagination.hasMore) return roles;
  }
  throw new Error("Role list exceeded the supported page limit");
}

/** Every staff member; the API pages this list in small pages. */
export async function getAdminUsers(): Promise<AdminUser[]> {
  const users: AdminUser[] = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const result = await apiData(getApiV1AdminAuthUsers({ query: { page, limit: 2 } }));
    users.push(...result.users);
    if (!result.pagination.hasMore) return users;
  }
  throw new Error("Staff list exceeded the supported page limit");
}
