import { describe, expect, it, vi } from "vitest";
import { isWithinRateLimit, rateLimitKey } from "./rate-limit";

function storeEnv(apiUrl: string, success = true) {
  return {
    PUBLIC_API_BASE_URL: apiUrl,
    RL_STRICT: { limit: vi.fn(async () => ({ success })) },
    RL_STANDARD: { limit: vi.fn(async () => ({ success })) },
  } as unknown as Env & {
    RL_STRICT: { limit: ReturnType<typeof vi.fn> };
    RL_STANDARD: { limit: ReturnType<typeof vi.fn> };
  };
}

describe("store-scoped native rate limiting", () => {
  it("never shares a counter between stores bound to the same account-wide namespace", async () => {
    const storeA = storeEnv("https://api.store-a.example");
    const storeB = storeEnv("https://api.store-b.example");

    const keyA = await rateLimitKey(storeA, "search", "203.0.113.7");
    expect(keyA).toBe(await rateLimitKey(storeA, "search", "203.0.113.7"));
    expect(keyA).not.toBe(await rateLimitKey(storeB, "search", "203.0.113.7"));
    expect(keyA).not.toBe(await rateLimitKey(storeA, "checkout-ip", "203.0.113.7"));
  });

  it("routes each tier to its own binding and keeps the subject out of the key", async () => {
    const env = storeEnv("https://api.store-a.example");

    await expect(isWithinRateLimit(env, "RL_STRICT", "checkout-phone", "+8801712345678")).resolves.toBe(true);
    expect(env.RL_STANDARD.limit).not.toHaveBeenCalled();
    const [[call]] = env.RL_STRICT.limit.mock.calls as [[{ key: string }]];
    expect(call.key).toMatch(/^[a-f0-9]{64}$/);
    expect(call.key).not.toContain("8801712345678");

    await expect(isWithinRateLimit(storeEnv("https://api.store-a.example", false), "RL_STANDARD", "search", "ip"))
      .resolves.toBe(false);
  });

  it("fails closed with 503 when the binding is missing", async () => {
    await expect(isWithinRateLimit({} as Env, "RL_STANDARD", "search", "ip"))
      .rejects.toMatchObject({ status: 503 });
  });
});
