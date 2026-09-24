import { afterEach, describe, expect, it, vi } from "vitest";
import { onlineManager } from "@tanstack/react-query";
import {
  ADMIN_QUERY_GC_TIME_MS,
  ADMIN_QUERY_RETRY,
  ADMIN_QUERY_STALE_TIME_MS,
  createAdminQueryClient,
} from "./admin-query-client";

describe("admin query client defaults", () => {
  afterEach(() => onlineManager.setOnline(true));

  it("keeps idle-tab resume refetches and long retry chains opt-in", () => {
    const client = createAdminQueryClient();
    const defaults = client.getDefaultOptions().queries;

    expect(defaults).toMatchObject({
      staleTime: ADMIN_QUERY_STALE_TIME_MS,
      gcTime: ADMIN_QUERY_GC_TIME_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: ADMIN_QUERY_RETRY,
    });
  });

  it("fails an offline save at once and never replays it when the connection returns", async () => {
    const client = createAdminQueryClient();
    const send = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    onlineManager.setOnline(false);

    const save = client.getMutationCache().build(client, { mutationFn: send });
    await expect(save.execute(undefined)).rejects.toThrow("Failed to fetch");
    expect(send).toHaveBeenCalledOnce();
    expect(save.state).toMatchObject({ status: "error", isPaused: false });

    // Back online: nothing queued is sent behind the merchant's back.
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
    expect(send).toHaveBeenCalledOnce();
  });

  it("fails an offline read at once instead of spinning", async () => {
    const client = createAdminQueryClient();
    onlineManager.setOnline(false);
    await expect(client.fetchQuery({
      queryKey: ["settings", "offline"],
      queryFn: async () => { throw new TypeError("Failed to fetch"); },
    })).rejects.toThrow("Failed to fetch");
  });
});
