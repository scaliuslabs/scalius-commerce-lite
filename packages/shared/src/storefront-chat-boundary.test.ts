import { describe, expect, it } from "vitest";

import {
  STOREFRONT_CHAT_CLIENT_IP_MAX_LENGTH,
  normalizeStorefrontChatClientIp,
  storefrontChatRateLimitBucketFromIp,
} from "./storefront-chat-boundary";

describe("storefront chat service-binding identity", () => {
  it("canonicalizes single IPv4 and IPv6 addresses", () => {
    expect(normalizeStorefrontChatClientIp("203.0.113.40")).toBe(
      "203.0.113.40",
    );
    expect(
      normalizeStorefrontChatClientIp(
        "2001:0db8:0000:0000:0000:0000:0000:0001",
      ),
    ).toBe("2001:db8::1");
  });

  it("uses one bucket for rotating IPv6 addresses inside the same /64", () => {
    expect(storefrontChatRateLimitBucketFromIp("203.0.113.40")).toBe(
      "ipv4:203.0.113.40",
    );
    expect(storefrontChatRateLimitBucketFromIp("2001:db8:abcd:12::1")).toBe(
      "ipv6:2001:0db8:abcd:0012/64",
    );
    expect(storefrontChatRateLimitBucketFromIp("2001:db8:abcd:12::ffff")).toBe(
      "ipv6:2001:0db8:abcd:0012/64",
    );
  });

  it("rejects proxy lists, ports, zones, PII, and oversized values", () => {
    for (const value of [
      "203.0.113.40, 198.51.100.2",
      "203.0.113.40:443",
      "fe80::1%eth0",
      "[2001:db8::1]",
      "buyer@example.test",
      "01711111111",
      "x".repeat(STOREFRONT_CHAT_CLIENT_IP_MAX_LENGTH + 1),
    ]) {
      expect(normalizeStorefrontChatClientIp(value)).toBeNull();
      expect(storefrontChatRateLimitBucketFromIp(value)).toBeNull();
    }
  });
});
