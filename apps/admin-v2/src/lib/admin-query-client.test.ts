import { describe, expect, it } from "vitest";
import {
  ADMIN_QUERY_GC_TIME_MS,
  ADMIN_QUERY_STALE_TIME_MS,
  createAdminQueryClient,
} from "./admin-query-client";

describe("admin query client defaults", () => {
  it("keeps idle-tab resume refetches opt-in", () => {
    const client = createAdminQueryClient();
    const defaults = client.getDefaultOptions().queries;

    expect(defaults).toMatchObject({
      staleTime: ADMIN_QUERY_STALE_TIME_MS,
      gcTime: ADMIN_QUERY_GC_TIME_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
  });
});
