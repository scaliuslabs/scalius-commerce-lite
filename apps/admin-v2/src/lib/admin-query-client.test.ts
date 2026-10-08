// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { onlineManager, QueryObserver } from "@tanstack/react-query";
import {
  ADMIN_QUERY_GC_TIME_MS,
  ADMIN_QUERY_RETRY,
  ADMIN_QUERY_STALE_TIME_MS,
  createAdminQueryClient,
  pollWhileOffline,
  setRealtimeOpen,
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

describe("polls that run only while the realtime hub is unreachable", () => {
  afterEach(() => {
    setRealtimeOpen(false);
    vi.useRealTimers();
  });

  it("drops a poll scheduled before the hub opened, and starts one the moment it closes", async () => {
    vi.useFakeTimers();
    const client = createAdminQueryClient();
    let fetches = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["inbox", "open"],
      queryFn: async () => ++fetches,
      refetchInterval: pollWhileOffline(30_000),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(1);
    // The hub opens a moment after the page: the 30 s poll never fires.
    await vi.advanceTimersByTimeAsync(1_500);
    setRealtimeOpen(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetches).toBe(1);
    // The hub drops: polling resumes on its interval.
    setRealtimeOpen(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches).toBe(2);
    unsubscribe();
  });
});
