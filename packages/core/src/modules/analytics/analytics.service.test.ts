import { describe, expect, it, vi } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import { toggleAnalyticsScript } from "./analytics.service";

describe("analytics service", () => {
  it("rejects activating an existing placeholder snippet", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => ({
              id: "analytics_1",
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
});
