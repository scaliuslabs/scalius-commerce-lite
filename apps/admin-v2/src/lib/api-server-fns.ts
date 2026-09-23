/**
 * The few admin API calls that must run on the dashboard Worker instead of in
 * the browser. Everything else calls the SDK directly through `lib/api.ts`.
 *
 * - Non-admin endpoints (`/api/v1/setup`, `/api/v1/auth/firebase-config`):
 *   the browser can only reach `/api/v1/admin/*` through the admin proxy.
 * - The admin list aggregates a tiny page size server-side over the service
 *   binding instead of making the browser walk every page.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  getApiV1AdminAuthUsers,
  getApiV1AuthFirebaseConfig,
  getApiV1Setup,
  postApiV1Setup,
} from "@scalius/api-client/sdk";
import { ADMIN_SETUP_TOKEN_HEADER } from "@scalius/shared/setup-token";
import { apiData, type ApiBody, type ApiResult } from "./api";

export type AdminUser = ApiResult<typeof getApiV1AdminAuthUsers>["users"][number];

export const getAdminUsers = createServerFn({ method: "GET" }).handler(async () => {
  const users: AdminUser[] = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const result = await apiData(getApiV1AdminAuthUsers({ query: { page, limit: 2 } }));
    users.push(...result.users);
    if (!result.pagination.hasMore) {
      return { users, pagination: result.pagination };
    }
  }
  throw new Error("Administrator list exceeded the supported page limit");
});

export const getSetupStatus = createServerFn({ method: "GET" }).handler(() =>
  apiData(getApiV1Setup()),
);

export const runSetup = createServerFn({ method: "POST" })
  .validator((data: ApiBody<typeof postApiV1Setup> & { setupToken?: string }) => data)
  .handler(async ({ data }) => {
    const { setupToken, ...body } = data;
    const token = setupToken?.trim();
    // The setup token travels as a header, never in the body or URL.
    return apiData(postApiV1Setup({
      body,
      headers: token ? { [ADMIN_SETUP_TOKEN_HEADER]: token } : undefined,
    }));
  });

export const getFirebaseConfig = createServerFn({ method: "GET" }).handler(async () => {
  const config = await apiData(getApiV1AuthFirebaseConfig());
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") normalized[key] = value;
  }
  return normalized;
});
