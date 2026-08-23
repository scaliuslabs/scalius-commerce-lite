import { describe, expect, it, vi } from "vitest";

import { ConflictError, ForbiddenError, ValidationError } from "@scalius/core/errors";
import {
  createAnalyticsScript,
  deleteAnalyticsScript,
  listAnalyticsScripts,
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

  it("forces known browser analytics providers into worker isolation", async () => {
    const values = vi.fn(() => ({
      returning: vi.fn(async () => [{ id: "analytics_meta" }]),
    }));
    const insert = vi.fn(() => ({ values }));

    await createAnalyticsScript({ insert } as never, {
      name: "Meta Pixel",
      type: "facebook_pixel",
      config: "<script>fbq('init', '123456789');</script>",
      location: "body_start",
      usePartytown: false,
      isActive: false,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ usePartytown: true }),
    );
  });

  it("does not let ordinary edit permission change activation", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => ({ id: "analytics_1", isActive: false, revision: 1 })),
          })),
        })),
      })),
      update: vi.fn(),
    };

    await expect(
      updateAnalyticsScript(db as never, "analytics_1", {
        id: "analytics_1",
        expectedRevision: 1,
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
              revision: 1,
            })),
          })),
        })),
      })),
      update: vi.fn(),
    };

    await expect(
      toggleAnalyticsScript(db as never, "analytics_1", {
        isActive: true,
        expectedRevision: 1,
      }),
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
              revision: 1,
            })),
          })),
        })),
      })),
      update: vi.fn(),
    };

    await expect(
      toggleAnalyticsScript(db as never, "analytics_cloudflare", {
        isActive: true,
        expectedRevision: 1,
      }),
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
              revision: 1,
            })),
          })),
        })),
      })),
      update: vi.fn(),
    };

    await expect(
      toggleAnalyticsScript(db as never, "analytics_tiktok", {
        isActive: true,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns paginated summaries without executable source", async () => {
    const row = {
      id: "analytics_ga4",
      name: "GA4 storefront",
      type: "google_analytics",
      config: "<script>gtag('config', 'G-ABC123DEF4');</script>",
      isActive: false,
      usePartytown: false,
      location: "head",
      revision: 3,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-02T00:00:00.000Z"),
      deletedAt: null,
    };
    const countQuery = { kind: "analytics-count" };
    const rowsQuery = { kind: "analytics-page" };
    const select = vi.fn()
      .mockReturnValueOnce({
        from: () => ({ where: () => countQuery }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => ({ offset: () => rowsQuery }) }),
          }),
        }),
      });
    const batch = vi.fn(async (statements: unknown[]) => {
      expect(statements).toEqual([countQuery, rowsQuery]);
      return [[{ count: 1 }], [row]];
    });

    const result = await listAnalyticsScripts({ select, batch } as never, { limit: 20 });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(result.pagination).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(result.scripts[0]).toMatchObject({
      id: "analytics_ga4",
      usePartytown: true,
      identifier: "G-ABC123DEF4",
      readiness: "ready_to_activate",
      revision: 3,
    });
    expect(result.scripts[0]).not.toHaveProperty("config");
  });

  it("requires explicit confirmation before a second provider becomes active", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({
        type: "google_analytics",
        config: "<script>gtag('config', 'G-ABC123DEF4');</script>",
        revision: 4,
      })
      .mockResolvedValueOnce({ id: "analytics_existing" });
    const db = {
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ limit: () => ({ get }), get }) }),
      })),
      update: vi.fn(),
    };

    await expect(toggleAnalyticsScript(db as never, "analytics_new", {
      isActive: true,
      expectedRevision: 4,
    })).rejects.toBeInstanceOf(ConflictError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("moves scripts to trash by deactivating them in the same guarded write", async () => {
    const set = vi.fn(() => ({
      where: () => ({
        returning: () => ({
          get: async () => ({
            id: "analytics_1",
            name: "Custom",
            type: "custom",
            config: "<script>window.demo = true;</script>",
            isActive: false,
            usePartytown: true,
            location: "head",
            revision: 2,
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            updatedAt: new Date("2026-07-02T00:00:00.000Z"),
            deletedAt: new Date("2026-07-02T00:00:00.000Z"),
          }),
        }),
      }),
    }));

    const result = await deleteAnalyticsScript(
      { update: () => ({ set }) } as never,
      "analytics_1",
      1,
    );

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
    expect(result).toMatchObject({ readiness: "trashed", revision: 2 });
    expect(result).not.toHaveProperty("config");
  });
});
