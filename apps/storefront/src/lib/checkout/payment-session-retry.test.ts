import { describe, expect, it, vi } from "vitest";

import {
  PaymentSessionProcessingTimeoutError,
  fetchPaymentSessionWithProcessingRetry,
} from "./payment-session-retry";

describe("payment session processing retry", () => {
  it("retries processing responses using retryAfterSeconds before returning a gateway URL", async () => {
    let now = 0;
    const delays: number[] = [];
    const fetchSession = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "processing",
        retryAfterSeconds: 3,
        message: "Payment session creation is already processing.",
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        gatewayUrl: "https://ssl.example.test/pay",
      }), { status: 200 }));

    const result = await fetchPaymentSessionWithProcessingRetry(fetchSession, {
      now: () => now,
      sleep: async (ms) => {
        delays.push(ms);
        now += ms;
      },
    });

    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([3000]);
    expect(result).toMatchObject({
      attempts: 2,
      data: { gatewayUrl: "https://ssl.example.test/pay" },
    });
  });

  it("honors Retry-After headers and reports progress without retrying hot", async () => {
    let now = 0;
    const events: Array<{ message: string; retryAfterSeconds: number; nextRetryDelayMs: number }> = [];
    const fetchSession = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "processing",
        message: "Gateway is preparing the checkout.",
      }), {
        status: 202,
        headers: { "Retry-After": "1" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        gatewayUrl: "https://ssl.example.test/pay",
      }), { status: 200 }));

    await fetchPaymentSessionWithProcessingRetry(fetchSession, {
      now: () => now,
      onProcessing: (event) => events.push({
        message: event.message,
        retryAfterSeconds: event.retryAfterSeconds,
        nextRetryDelayMs: event.nextRetryDelayMs,
      }),
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{
      message: "Gateway is preparing the checkout.",
      retryAfterSeconds: 1,
      nextRetryDelayMs: 2000,
    }]);
  });

  it("detects wrapped processing payloads and fails closed after the bounded window", async () => {
    const fetchSession = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        status: "processing",
        retryAfterSeconds: 30,
        message: "Payment session creation is already processing. Please try again shortly.",
      },
    }), { status: 202 }));

    await expect(fetchPaymentSessionWithProcessingRetry(fetchSession))
      .rejects.toMatchObject({
        name: "PaymentSessionProcessingTimeoutError",
        attempts: 1,
        retryAfterSeconds: 30,
        status: 202,
        message: "Payment session creation is already processing. Please try again shortly.",
      } satisfies Partial<PaymentSessionProcessingTimeoutError>);
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });
});
