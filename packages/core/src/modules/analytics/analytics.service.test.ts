import { describe, expect, it, vi } from "vitest";

import { ForbiddenError, ValidationError } from "@scalius/core/errors";
import {
  createAnalyticsScript,
  toggleAnalyticsScript,
  updateAnalyticsScript,
} from "./analytics.service";

describe("analytics service", () => {
  const validScript = {
    name: "Custom analytics",
    type: "custom" as const,
    config: "<script>window.demo = true;</script>",
    location: "head" as const,
    usePartytown: true,
    isActive: true,
  };

  it("requires lifecycle authority to create an active script", async () => {
    await expect(
      createAnalyticsScript({} as never, validScript),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const insert = vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: "analytics_1" }]),
      })),
    }));
    await expect(
      createAnalyticsScript(
        { insert } as never,
        validScript,
        { canToggle: true },
      ),
    ).resolves.toMatchObject({
      id: expect.stringMatching(/^analytics_/),
      script: expect.objectContaining({ id: "analytics_1" }),
    });
  });

  it("does not let ordinary edit permission change activation", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => ({ id: "analytics_1", isActive: false })),
          })),
        })),
      })),
      update: vi.fn(),
    };

    await expect(
      updateAnalyticsScript(db as never, "analytics_1", {
        id: "analytics_1",
        ...validScript,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects activating an existing placeholder snippet", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => ({
              id: "analytics_1",
              type: "facebook_pixel",
              config: "<script>fbq('init', 'PIXEL_ID');</script>",
            })),
          })),
        })),
      })),
      update: vi.fn(),
    };

    await expect(
      toggleAnalyticsScript(db as never, "analytics_1", true),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects activating an existing Cloudflare Web Analytics placeholder", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => ({
              id: "analytics_cloudflare",
              type: "cloudflare_web_analytics",
              config:
                "<script defer src=\"https://static.cloudflareinsights.com/beacon.min.js\" data-cf-beacon='{\"token\":\"YOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN\"}'></script>",
            })),
          })),
        })),
      })),
      update: vi.fn(),
    };

    await expect(
      toggleAnalyticsScript(db as never, "analytics_cloudflare", true),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects activating an existing provider-mismatched snippet", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => ({
              id: "analytics_tiktok",
              type: "tiktok_pixel",
              config:
                "<script>gtag('config', 'G-ABC123DEF4');</script>",
            })),
          })),
        })),
      })),
      update: vi.fn(),
    };

    await expect(
      toggleAnalyticsScript(db as never, "analytics_tiktok", true),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.update).not.toHaveBeenCalled();
  });
});
