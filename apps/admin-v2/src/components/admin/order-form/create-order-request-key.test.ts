// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminOrderRequestKeyStorage,
  clearAdminOrderRequestKey,
  getOrCreateAdminOrderRequestKey,
  rememberSubmittedAdminOrderRequestKey,
  replaceSubmittedAdminOrderRequestKey,
} from "./create-order-request-key";

describe("manual order request key recovery", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.useRealTimers();
  });

  it("does not persist an untouched form key", () => {
    const key = getOrCreateAdminOrderRequestKey();

    expect(key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(window.sessionStorage.getItem(adminOrderRequestKeyStorage.key)).toBeNull();
  });

  it("recovers the same opaque key after a submitted request loses its response", () => {
    const key = crypto.randomUUID();
    rememberSubmittedAdminOrderRequestKey(key);

    expect(getOrCreateAdminOrderRequestKey()).toBe(key);
  });

  it("expires stale recovery keys", () => {
    const key = crypto.randomUUID();
    const now = new Date("2026-07-17T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    rememberSubmittedAdminOrderRequestKey(key);
    vi.setSystemTime(now.getTime() + adminOrderRequestKeyStorage.maxRecoveryAgeMs + 1);

    expect(getOrCreateAdminOrderRequestKey()).not.toBe(key);
    expect(window.sessionStorage.getItem(adminOrderRequestKeyStorage.key)).toBeNull();
  });

  it("clears only the matching request key", () => {
    const key = crypto.randomUUID();
    rememberSubmittedAdminOrderRequestKey(key);

    clearAdminOrderRequestKey(crypto.randomUUID());
    expect(getOrCreateAdminOrderRequestKey()).toBe(key);

    clearAdminOrderRequestKey(key);
    expect(window.sessionStorage.getItem(adminOrderRequestKeyStorage.key)).toBeNull();
  });

  it("replaces a definitively failed request with one fresh persisted key", () => {
    const failedKey = crypto.randomUUID();
    rememberSubmittedAdminOrderRequestKey(failedKey);

    const replacement = replaceSubmittedAdminOrderRequestKey(failedKey);

    expect(replacement).not.toBe(failedKey);
    expect(replacement).toMatch(/^[0-9a-f-]{36}$/i);
    expect(getOrCreateAdminOrderRequestKey()).toBe(replacement);
  });
});
