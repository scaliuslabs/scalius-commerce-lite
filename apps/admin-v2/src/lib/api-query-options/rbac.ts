import {
  getApiV1AdminRbacPermissions,
  getApiV1AdminRbacRoles,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "../api";

export type RbacRole = ApiResult<typeof getApiV1AdminRbacRoles>["roles"][number];
export type RbacPermissionMetadata =
  ApiResult<typeof getApiV1AdminRbacPermissions>["grouped"][string][number];

/** Every role; the API pages roles one at a time to bound permission enrichment. */
export async function getRbacRoles() {
  const roles: RbacRole[] = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const result = await apiData(getApiV1AdminRbacRoles({ query: { page, limit: 1 } }));
    roles.push(...result.roles);
    if (!result.pagination.hasMore) {
      return { roles, pagination: result.pagination };
    }
  }
  throw new Error("Role list exceeded the supported page limit");
}

export const getRbacPermissions = () => apiData(getApiV1AdminRbacPermissions());
