import { createAdminApiFunction as createServerFn } from "../admin-api-function";
import type { HomepagePresentationConfig } from "@scalius/shared/homepage-presentation";
import { apiGet, apiPost } from "../api";

export interface HomepagePresentationDocument {
  config: HomepagePresentationConfig;
  revision: number;
}

export type SaveHomepagePresentationInput = HomepagePresentationConfig & {
  expectedRevision: number;
};

export const getHomepagePresentation = createServerFn({ method: "GET" })
  .handler(async (): Promise<HomepagePresentationDocument> => {
    return apiGet<HomepagePresentationDocument>(
      "/settings/homepage-presentation",
    );
  });

export const saveHomepagePresentation = createServerFn({ method: "POST" })
  .validator((data: SaveHomepagePresentationInput) => data)
  .handler(async ({ data }): Promise<HomepagePresentationDocument> => {
    return apiPost<HomepagePresentationDocument>(
      "/settings/homepage-presentation",
      data,
    );
  });
