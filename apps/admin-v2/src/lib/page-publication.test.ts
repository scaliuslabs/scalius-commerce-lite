import { describe, expect, it } from "vitest";
import {
  defaultPageScheduleDate,
  getPagePublicationMode,
  isPageLive,
  publicationFieldsForInput,
  toDateTimeLocalValue,
} from "./page-publication";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");

describe("page publication state", () => {
  it("distinguishes draft, scheduled, and buyer-resolvable pages", () => {
    expect(getPagePublicationMode({ isPublished: false, publishedAt: null }, NOW)).toBe("draft");
    expect(getPagePublicationMode({ isPublished: true, publishedAt: "2026-07-20T12:00:00.000Z" }, NOW)).toBe("scheduled");
    expect(getPagePublicationMode({ isPublished: true, publishedAt: 1784548800 }, NOW)).toBe("scheduled");
    expect(getPagePublicationMode({ isPublished: true, publishedAt: "2026-07-18T12:00:00.000Z" }, NOW)).toBe("published");
    expect(getPagePublicationMode({ isPublished: true, publishedAt: null }, NOW)).toBe("published");
    expect(isPageLive({ isPublished: true, publishedAt: "2026-07-20T12:00:00.000Z" }, NOW)).toBe(false);
  });

  it("keeps an existing live timestamp but clears future scheduling for publish-now", () => {
    expect(publicationFieldsForInput({
      mode: "published",
      publishedAt: new Date("2026-07-18T12:00:00.000Z"),
      now: NOW,
    })).toEqual({
      isPublished: true,
      publishedAt: "2026-07-18T12:00:00.000Z",
    });
    expect(publicationFieldsForInput({
      mode: "published",
      publishedAt: new Date("2026-07-20T12:00:00.000Z"),
      now: NOW,
    })).toEqual({ isPublished: true, publishedAt: null });
  });

  it("uses explicit fields for draft and scheduled saves", () => {
    expect(publicationFieldsForInput({ mode: "draft" })).toEqual({
      isPublished: false,
      publishedAt: null,
    });
    expect(publicationFieldsForInput({
      mode: "scheduled",
      publishedAt: new Date("2026-07-20T12:00:00.000Z"),
    })).toEqual({
      isPublished: true,
      publishedAt: "2026-07-20T12:00:00.000Z",
    });
  });

  it("creates a stable next-day default and local datetime value", () => {
    expect(defaultPageScheduleDate(new Date(NOW)).toISOString()).toBe("2026-07-20T12:00:00.000Z");
    expect(toDateTimeLocalValue(new Date("2026-07-20T12:34:00.000Z"))).toMatch(/^2026-07-20T/);
    expect(toDateTimeLocalValue(1784550840)).toMatch(/^2026-07-20T/);
    expect(toDateTimeLocalValue(null)).toBe("");
  });
});
