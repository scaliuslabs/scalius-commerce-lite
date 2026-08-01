import { createAdminApiFunction as createServerFn } from "../admin-api-function";
import { apiGet, apiPost } from "../api";

type MessagePayload = { message?: string };

export interface StorefrontUrlPayload {
  storefrontUrl: string;
}

export interface UpdateStorefrontUrlInput {
  storefrontUrl: string;
}

export const getStorefrontUrl = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<StorefrontUrlPayload>("/settings/storefront-url");
  },
);

export const updateStorefrontUrl = createServerFn({ method: "POST" })
  .validator((data: UpdateStorefrontUrlInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/storefront-url", data);
  });
