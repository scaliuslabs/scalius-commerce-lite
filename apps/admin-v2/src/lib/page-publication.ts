import { unixToDate } from "@scalius/shared/timestamps";

export const PAGE_PUBLICATION_MODES = ["draft", "published", "scheduled"] as const;

export type PagePublicationMode = (typeof PAGE_PUBLICATION_MODES)[number];

export interface PagePublicationFacts {
  isPublished: boolean;
  publishedAt?: Date | string | number | null;
}

function timestamp(value: PagePublicationFacts["publishedAt"]): number | null {
  return unixToDate(value)?.getTime() ?? null;
}

export function getPagePublicationMode(
  page: PagePublicationFacts,
  now = Date.now(),
): PagePublicationMode {
  if (!page.isPublished) return "draft";
  const publicationTime = timestamp(page.publishedAt);
  return publicationTime !== null && publicationTime > now
    ? "scheduled"
    : "published";
}

export function isPageLive(page: PagePublicationFacts, now = Date.now()): boolean {
  return getPagePublicationMode(page, now) === "published";
}

export function defaultPageScheduleDate(now = new Date()): Date {
  const result = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  result.setSeconds(0, 0);
  return result;
}

export function toDateTimeLocalValue(value: Date | string | number | null | undefined): string {
  const date = unixToDate(value);
  if (!date) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function publicationFieldsForInput(input: {
  mode: PagePublicationMode;
  publishedAt?: Date | null;
  now?: number;
}): { isPublished: boolean; publishedAt: string | null } {
  if (input.mode === "draft") {
    return { isPublished: false, publishedAt: null };
  }

  if (input.mode === "scheduled") {
    return {
      isPublished: true,
      publishedAt: input.publishedAt?.toISOString() ?? null,
    };
  }

  const publicationTime = input.publishedAt?.getTime();
  return {
    isPublished: true,
    publishedAt:
      publicationTime != null && publicationTime <= (input.now ?? Date.now())
        ? input.publishedAt!.toISOString()
        : null,
  };
}
