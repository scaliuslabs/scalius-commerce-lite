// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { reviewsMessages } from "~/i18n/reviews";
import { shellMessages } from "~/i18n/shell";

const sdk = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn(),
  moderate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, params: _params, search: _search, ...props }: { to: string; children: ReactNode; params?: unknown; search?: unknown }) =>
    <a href={to} {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@scalius/api-client/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiV1AdminReviews: sdk.list,
  getApiV1AdminReviewsSummary: sdk.summary,
  postApiV1AdminReviewsModerate: sdk.moderate,
}));

import type { AdminReview } from "~/lib/api-query-options/reviews";
import { ReviewsNavBadge } from "./ReviewsNavBadge";
import { ReviewsPage } from "./ReviewsPage";
import { reviewListQuery, validateReviewSearch } from "./review-search";
import { moderateReviews, moderationBody, parseBlockWords, settingsBody, settingsForm, undoableRejection } from "./reviews-api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = reviewsMessages.en;
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: new Response() });

const review = (id: string, overrides: Partial<AdminReview> = {}): AdminReview => ({
  id,
  status: "pending",
  rating: 2,
  title: "Strap broke",
  body: "Visit example.com for a better one",
  authorName: "Rahim U.",
  authorType: "customer",
  variantLabel: "Black / M",
  product: { id: "prd_1", name: "Leather watch", slug: "leather-watch", imageUrl: null },
  order: { id: "ord_1", orderNumber: "#1057" },
  checkFlags: ["url"],
  moderationReason: null,
  reply: null,
  conversationId: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  publishedAt: null,
  editedAt: null,
  updatedAt: "2026-09-20T10:00:00.000Z",
  version: 1,
  ...overrides,
});

describe("reviews URL state", () => {
  it("keeps only known tabs, star ratings and opaque ids", () => {
    expect(validateReviewSearch({ status: "rejected", rating: "4", productId: "prd_1", q: "  strap  ", review: "rev_1" }))
      .toEqual({ status: "rejected", rating: 4, productId: "prd_1", q: "strap", review: "rev_1" });
    expect(validateReviewSearch({ status: "pending", rating: 6, productId: "rahim@example.com", review: "a b" })).toEqual({});
    expect(validateReviewSearch({ status: "withdrawn", rating: [5], q: "   " })).toEqual({});
    expect(validateReviewSearch({ q: "x".repeat(150) }).q).toHaveLength(100);
  });

  it("asks the list for the Pending tab by default", () => {
    expect(reviewListQuery({})).toEqual({ status: "pending" });
    expect(reviewListQuery({ status: "published", rating: 5, productId: "prd_1", q: "good", review: "rev_1" }))
      .toEqual({ status: "published", rating: 5, productId: "prd_1", q: "good" });
  });
});

describe("review moderation requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a content reason to reject and sends a fresh request key every click", () => {
    expect(() => moderationBody(["rev_1"], "reject")).toThrow();
    expect(() => moderationBody([], "publish")).toThrow();
    const reject = moderationBody(["rev_1", "rev_2"], "reject", "spam");
    expect(reject).toMatchObject({ ids: ["rev_1", "rev_2"], action: "reject", reason: "spam" });
    expect(reject.requestKey.length).toBeGreaterThanOrEqual(8);
    const publish = moderationBody(["rev_1"], "publish");
    expect(publish).not.toHaveProperty("reason");
    expect(publish.requestKey).not.toBe(reject.requestKey);
  });

  it("splits a large selection into requests of 90", async () => {
    sdk.moderate.mockImplementation(({ body }: { body: { ids: string[] } }) =>
      ok({ updated: body.ids.map((id) => ({ id, previousStatus: "published" })), skipped: [] }));
    const ids = Array.from({ length: 91 }, (_, index) => `rev_${index}`);
    const result = await moderateReviews(ids, "reject", "abusive");
    expect(sdk.moderate).toHaveBeenCalledTimes(2);
    const [first, second] = sdk.moderate.mock.calls.map(([options]) => options.body);
    expect(first.ids).toHaveLength(90);
    expect(second.ids).toEqual(["rev_90"]);
    expect(second.requestKey).not.toBe(first.requestKey);
    expect(result.updated).toHaveLength(91);
  });

  it("offers undo only for reviews that were live before the rejection", () => {
    expect(undoableRejection({
      updated: [{ id: "rev_1", previousStatus: "published" }, { id: "rev_2", previousStatus: "pending" }],
      skipped: ["rev_3"],
    })).toEqual(["rev_1"]);
  });
});

describe("review settings form", () => {
  const saved = { enabled: true, moderation: "auto" as const, requestsEnabled: true, requestDelayDays: 7, blockWords: ["scam", "fake"], revision: 3 };

  it("round-trips the saved settings and sends the loaded revision", () => {
    const form = settingsForm(saved);
    expect(form.blockWords).toBe("scam\nfake");
    const result = settingsBody({ ...form, moderation: "hold", requestDelayDays: " 14 ", blockWords: " scam \n\nFake\nfake\nbad  word " }, saved.revision);
    expect(result).toEqual({
      ok: true,
      body: { enabled: true, moderation: "hold", requestsEnabled: true, requestDelayDays: 14, blockWords: ["scam", "Fake", "bad word"], expectedRevision: 3 },
    });
  });

  it("says what to fix before saving", () => {
    const form = settingsForm(saved);
    expect(settingsBody({ ...form, requestDelayDays: "0" }, 3)).toEqual({ ok: false, error: "delayInvalid" });
    expect(settingsBody({ ...form, requestDelayDays: "61" }, 3)).toEqual({ ok: false, error: "delayInvalid" });
    expect(settingsBody({ ...form, requestDelayDays: "7.5" }, 3)).toEqual({ ok: false, error: "delayInvalid" });
    const many = Array.from({ length: 51 }, (_, index) => `word${index}`).join("\n");
    expect(settingsBody({ ...form, blockWords: many }, 3)).toEqual({ ok: false, error: "blockWordsTooMany" });
    expect(settingsBody({ ...form, blockWords: "x".repeat(41) }, 3)).toEqual({ ok: false, error: "blockWordTooLong" });
    expect(parseBlockWords("")).toEqual([]);
  });
});

describe("reviews screens", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (node: ReactNode, permissions: string[] = ["reviews.view", "reviews.moderate"]) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <PermissionProvider permissions={permissions}>{node}</PermissionProvider>
      </QueryClientProvider>,
    ));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label) as HTMLButtonElement | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("hides the sidebar badge at zero and shows the pending count otherwise", async () => {
    sdk.summary.mockImplementation(() => ok({ pending: 0, published: 4, rejected: 1, product: null }));
    await render(<ReviewsNavBadge />);
    expect(host.textContent).toBe("");

    act(() => root.unmount());
    root = createRoot(host);
    sdk.summary.mockImplementation(() => ok({ pending: 3, published: 4, rejected: 1, product: null }));
    await render(<ReviewsNavBadge />);
    expect(host.textContent).toBe("3");
    expect(host.querySelector("span")?.getAttribute("aria-label")).toBe(shellMessages.en.reviewsPending.replace("{count}", "3"));
  });

  it("lists held reviews with why they were held, and rejects a selection only with a reason", async () => {
    sdk.summary.mockImplementation(() => ok({ pending: 2, published: 0, rejected: 0, product: null }));
    sdk.list.mockImplementation(() => ok({ items: [review("rev_1"), review("rev_2", { title: null, checkFlags: [] })], nextCursor: null }));
    sdk.moderate.mockImplementation(() => ok({ updated: [{ id: "rev_1", previousStatus: "pending" }, { id: "rev_2", previousStatus: "pending" }], skipped: [] }));
    await render(<ReviewsPage search={{}} onSearchChange={vi.fn()} />);

    expect(sdk.list).toHaveBeenCalledWith({ query: { status: "pending", cursor: undefined } });
    expect(host.textContent).toContain(en["tab.pending"]);
    expect(host.textContent).toContain("Strap broke");
    expect(host.textContent).toContain(en["flag.url"]);
    expect(host.textContent).toContain(en.verified);
    expect(host.querySelectorAll('[role="img"]')[0]?.getAttribute("aria-label")).toBe(en.stars.replace("{rating}", "2"));

    await act(async () => (host.querySelector(`button[aria-label="${en.selectAll}"]`) as HTMLButtonElement).click());
    await act(async () => button(en.reject)!.click());
    const submit = [...document.querySelectorAll('[data-slot="dialog-footer"] button')].find((item) => item.textContent === en.reject) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const reason = document.querySelector('[data-slot="dialog-content"] select') as HTMLSelectElement;
    expect([...reason.options].slice(1).map((option) => option.value)).toEqual(["spam", "abusive", "personal_info", "off_topic", "not_about_product"]);
    await act(async () => {
      reason.value = "off_topic";
      reason.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(sdk.moderate).toHaveBeenCalledTimes(1);
    const body = sdk.moderate.mock.calls[0]![0].body;
    expect(body).toMatchObject({ ids: ["rev_1", "rev_2"], action: "reject", reason: "off_topic" });
    expect(typeof body.requestKey).toBe("string");
    expect(body.requestKey.length).toBeGreaterThanOrEqual(8);
  });

  it("shows each tab's empty state, and no moderation controls to viewers", async () => {
    sdk.summary.mockImplementation(() => ok({ pending: 0, published: 0, rejected: 0, product: null }));
    sdk.list.mockImplementation(() => ok({ items: [], nextCursor: null }));
    await render(<ReviewsPage search={{ status: "rejected" }} onSearchChange={vi.fn()} />, ["reviews.view"]);
    expect(host.textContent).toContain(en["empty.rejected"]);
    expect(button(en.settings)).toBeUndefined();
  });
});
