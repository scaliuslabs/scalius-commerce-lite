import { describe, expect, it } from "vitest";

import {
  normalizeCheckoutRedirectUrl,
  normalizeHostedCheckoutUrl,
} from "./redirect-url";

describe("checkout redirect URL policy", () => {
  it("accepts HTTPS gateways and loopback HTTP only", () => {
    expect(normalizeHostedCheckoutUrl("https://secure.example/pay?id=1")).toBe(
      "https://secure.example/pay?id=1",
    );
    expect(normalizeHostedCheckoutUrl("http://127.0.0.1:8787/pay")).toBe(
      "http://127.0.0.1:8787/pay",
    );
    expect(normalizeHostedCheckoutUrl("http://gateway.example/pay")).toBeNull();
    expect(normalizeHostedCheckoutUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeHostedCheckoutUrl("data:text/html,pwned")).toBeNull();
    expect(normalizeHostedCheckoutUrl("https://user:pass@gateway.example/pay")).toBeNull();
  });

  it("keeps internal receipt redirects relative and rejects unsafe schemes", () => {
    expect(normalizeCheckoutRedirectUrl(
      "/order-success?orderId=order_1",
      "https://shop.example",
    )).toBe("/order-success?orderId=order_1");
    expect(normalizeCheckoutRedirectUrl(
      "https://shop.example/order-success?orderId=order_1",
      "https://shop.example",
    )).toBe("/order-success?orderId=order_1");
    expect(normalizeCheckoutRedirectUrl(
      "javascript:alert(1)",
      "https://shop.example",
    )).toBeNull();
  });
});
