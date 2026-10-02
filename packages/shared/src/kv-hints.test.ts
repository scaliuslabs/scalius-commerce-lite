import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KV_HINT_BREAKER_INITIAL_MS,
  KV_HINT_BREAKER_MAX_MS,
  deleteKvHint,
  isKvWriteRefusal,
  kvHintWritesPaused,
  putKvHint,
  resetKvHintBreaker,
} from "./kv-hints";

const quota = () => new Error("KV put() limit exceeded for the day.");

function kv(failWith?: () => Error) {
  const put = vi.fn(async () => { if (failWith) throw failWith(); });
  const del = vi.fn(async () => { if (failWith) throw failWith(); });
  return { put, delete: del } as unknown as KVNamespace & { put: typeof put; delete: typeof del };
}

afterEach(() => resetKvHintBreaker());

describe("KV hint writes", () => {
  it("writes a hint and reports it", async () => {
    const store = kv();
    expect(await putKvHint(store, "k", "v", { expirationTtl: 60 })).toBe(true);
    expect(store.put).toHaveBeenCalledWith("k", "v", { expirationTtl: 60 });
    expect(await deleteKvHint(store, "k")).toBe(true);
    expect(store.delete).toHaveBeenCalledWith("k");
  });

  it("does nothing without a binding", async () => {
    expect(await putKvHint(undefined, "k", "v")).toBe(false);
    expect(await deleteKvHint(null, "k")).toBe(false);
  });

  it("never throws, whatever KV answers", async () => {
    const store = kv(() => new TypeError("network lost"));
    await expect(putKvHint(store, "k", "v")).resolves.toBe(false);
    await expect(deleteKvHint(store, "k")).resolves.toBe(false);
    // An ordinary failure is not a quota: the next write still goes to KV.
    expect(kvHintWritesPaused()).toBe(false);
    await putKvHint(store, "k", "v");
    expect(store.put).toHaveBeenCalledTimes(2);
  });

  it("recognises a daily quota and a per-key rate refusal, and nothing else", () => {
    expect(isKvWriteRefusal(quota())).toBe(true);
    expect(isKvWriteRefusal(new Error("KV PUT failed: 429 Too Many Requests"))).toBe(true);
    expect(isKvWriteRefusal(new Error("KV DELETE failed: 429"))).toBe(true);
    expect(isKvWriteRefusal(new Error("value too large"))).toBe(false);
    expect(isKvWriteRefusal(new TypeError("fetch failed"))).toBe(false);
    expect(isKvWriteRefusal(undefined)).toBe(false);
  });

  it("stops calling KV once it refuses, then probes again with a doubling pause", async () => {
    const store = kv(quota);
    let now = 1_000;
    const clock = () => now;

    // The first refusal opens the breaker: that is the only failing call.
    expect(await putKvHint(store, "a", "1", undefined, clock)).toBe(false);
    expect(kvHintWritesPaused(clock)).toBe(true);
    for (let index = 0; index < 50; index += 1) {
      expect(await putKvHint(store, `k${index}`, "1", undefined, clock)).toBe(false);
      expect(await deleteKvHint(store, `k${index}`, clock)).toBe(false);
    }
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.delete).not.toHaveBeenCalled();

    // After the pause one probe goes through; refused again, the pause doubles.
    now += KV_HINT_BREAKER_INITIAL_MS;
    expect(kvHintWritesPaused(clock)).toBe(false);
    await putKvHint(store, "b", "1", undefined, clock);
    expect(store.put).toHaveBeenCalledTimes(2);
    now += KV_HINT_BREAKER_INITIAL_MS;
    expect(kvHintWritesPaused(clock)).toBe(true);
    now += KV_HINT_BREAKER_INITIAL_MS;
    expect(kvHintWritesPaused(clock)).toBe(false);

    // The pause is capped.
    for (let round = 0; round < 12; round += 1) {
      now += KV_HINT_BREAKER_MAX_MS + 1;
      await putKvHint(store, "c", "1", undefined, clock);
    }
    now += KV_HINT_BREAKER_MAX_MS - 1;
    expect(kvHintWritesPaused(clock)).toBe(true);
    now += 2;
    expect(kvHintWritesPaused(clock)).toBe(false);
  });

  it("closes for good once a write succeeds, and resets the backoff", async () => {
    let now = 5_000;
    const clock = () => now;
    const refusing = kv(quota);
    await putKvHint(refusing, "a", "1", undefined, clock);
    now += KV_HINT_BREAKER_INITIAL_MS;
    expect(await putKvHint(kv(), "b", "1", undefined, clock)).toBe(true);
    expect(kvHintWritesPaused(clock)).toBe(false);
    // The next refusal starts from the initial pause again.
    await putKvHint(refusing, "c", "1", undefined, clock);
    now += KV_HINT_BREAKER_INITIAL_MS - 1;
    expect(kvHintWritesPaused(clock)).toBe(true);
    now += 1;
    expect(kvHintWritesPaused(clock)).toBe(false);
  });
});
