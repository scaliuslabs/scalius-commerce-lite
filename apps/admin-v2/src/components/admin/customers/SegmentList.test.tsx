// @vitest-environment happy-dom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "~/i18n";
import { customerSegmentMessages } from "~/i18n/customer-segments";
import { customersMessages } from "~/i18n/customers";
import { resourceMessages } from "~/i18n/resource";
import { queryKeys } from "~/lib/query-keys";
import { writeListSearch } from "~/lib/list-search";
import { writeSavedPageSize } from "~/lib/list-helpers";

const sdk = vi.hoisted(() => ({
  getApiV1AdminCustomersSegments: vi.fn(),
  getApiV1AdminCustomersSegmentsBySegmentId: vi.fn(),
  getApiV1AdminCustomersSegmentsBySegmentIdCount: vi.fn(),
  getApiV1AdminCustomersTags: vi.fn(),
  deleteApiV1AdminCustomersSegmentsBySegmentId: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/components/admin/apps/ui/list-columns", () => ({ useAppResourceColumns: () => ({ all: [] }) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ to, children, search: _search, params: _params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode; search?: unknown; params?: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { SegmentList } from "./SegmentList";
import { CustomerListFilters } from "./CustomerListFilters";
import { validateCustomerSearch } from "./customer-list-search";
import type { CustomerSegment } from "~/lib/api-query-options/customers";
const validate = (value: Record<string, unknown>) => validateCustomerSearch(value as Parameters<typeof validateCustomerSearch>[0]);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEGMENTS: CustomerSegment[] = Array.from({ length: 45 }, (_, index) => ({
  id: `seg_${index}`, name: `Segment ${index + 1}`, description: index < 3 ? "ঢাকার ক্রেতা" : null,
  definition: { version: 1, match: "all", conditions: [{ field: "orders_count", min: 2 }] },
  revision: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", promotionCount: 0,
}));
const ok = <T,>(data: T) => ({ data: { success: true, data }, response: { status: 200 } });
const t = (key: keyof typeof customerSegmentMessages.en, vars?: Record<string, string | number>) => translate(customerSegmentMessages, key, vars);
const c = (key: keyof typeof customersMessages.en) => translate(customersMessages, key);
const r = (key: keyof typeof resourceMessages.en) => translate(resourceMessages, key);
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("segment list and filter request budgets", () => {
  let root: Root;
  let host: HTMLDivElement;
  let client: QueryClient;
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const countButtons = () => [...host.querySelectorAll<HTMLButtonElement>("button")].filter((node) => node.getAttribute("aria-label")?.startsWith("Count customers in "));
  const render = async (node: ReactNode) => {
    await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
    await settle();
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    await settle();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    setLocale("en");
    writeListSearch("segments", "");
    writeSavedPageSize("segments", 20);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    sdk.getApiV1AdminCustomersSegments.mockResolvedValue(ok({ segments: SEGMENTS }));
    sdk.getApiV1AdminCustomersSegmentsBySegmentId.mockResolvedValue(ok(SEGMENTS[0]));
    sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount.mockResolvedValue(ok({ count: 1234, capped: false }));
    sdk.getApiV1AdminCustomersTags.mockResolvedValue(ok({ tags: [] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
    vi.restoreAllMocks();
    setLocale("en");
  });

  it("pages and searches metadata without scanning member counts or putting search in the URL", async () => {
    const url = window.location.href;
    await render(<SegmentList />);
    expect(countButtons()).toHaveLength(20);
    await act(async () => button(r("next")).click());
    expect(countButtons()).toHaveLength(20);
    expect(countButtons()[0]?.getAttribute("aria-label")).toContain("Segment 21");
    const search = host.querySelector<HTMLInputElement>(`input[aria-label="${t("searchSegments")}"]`)!;
    await type(search, "ঢাকার");
    expect(countButtons()).toHaveLength(3);
    await type(search, "not present");
    expect(host.querySelector('[data-state-kind="filtered"]')).not.toBeNull();
    await type(search, "");
    expect(countButtons()).toHaveLength(20);
    expect(countButtons()[0]?.getAttribute("aria-label")).toContain("Segment 1");
    expect(sdk.getApiV1AdminCustomersSegments).toHaveBeenCalledTimes(1);
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount).not.toHaveBeenCalled();
    expect(window.location.href).toBe(url);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("clamps the last page when deleting its last rows", async () => {
    await render(<SegmentList />);
    await act(async () => button(r("next")).click());
    await act(async () => button(r("next")).click());
    expect(countButtons()).toHaveLength(5);
    await act(async () => { client.setQueryData(queryKeys.customers.segments(), { segments: SEGMENTS.slice(0, 40) }); });
    await settle();
    expect(countButtons()).toHaveLength(20);
    expect(countButtons()[0]?.getAttribute("aria-label")).toContain("Segment 21");
    await act(async () => { client.setQueryData(queryKeys.customers.segments(), { segments: SEGMENTS }); });
    await settle();
    expect(countButtons()[0]?.getAttribute("aria-label")).toContain("Segment 21");
    await act(async () => button(r("previous")).click());
    expect(countButtons()[0]?.getAttribute("aria-label")).toContain("Segment 1");
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount).not.toHaveBeenCalled();
  });

  it("respects the shared default page size when its saved override is cleared", async () => {
    writeSavedPageSize("segments", 50);
    await render(<SegmentList />);
    expect(countButtons()).toHaveLength(45);
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount).not.toHaveBeenCalled();
  });

  it("counts only the requested segment and retries a failed count explicitly", async () => {
    let answer!: (value: unknown) => void;
    sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await render(<SegmentList />);
    const first = countButtons()[0]!;
    await act(async () => { first.click(); first.click(); });
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount).toHaveBeenCalledTimes(1);
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount).toHaveBeenCalledWith({ path: { segmentId: "seg_0" } });
    await act(async () => answer({ error: { success: false, error: { code: "UNAVAILABLE", message: "Try again" } }, response: { status: 503 } }));
    await settle();
    expect(host.textContent).toContain(t("countFailed"));
    await act(async () => button(t("retryCountFor", { name: "Segment 1" })).click());
    await settle();
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(t("members", { count: 1234 }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows cached counts and Bangla actions without a refresh request", async () => {
    setLocale("bn");
    client.setQueryData(queryKeys.customers.segmentCount("seg_0"), { count: 1234, capped: true });
    await render(<SegmentList />);
    expect(host.textContent).toContain(t("membersCapped", { count: 1234 }));
    expect(button(t("refreshCountFor", { name: "Segment 1" }))).not.toBeNull();
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.customers.segments() }); });
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount).not.toHaveBeenCalled();
  });

  it("loads the segment filter only when opened and reuses bounded metadata for its search", async () => {
    await render(<CustomerListFilters search={validate({})} />);
    expect(sdk.getApiV1AdminCustomersSegments).not.toHaveBeenCalled();
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentId).not.toHaveBeenCalled();
    await act(async () => button(c("filterSegment")).click());
    await settle();
    expect(sdk.getApiV1AdminCustomersSegments).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(20);
    await type(document.querySelector<HTMLInputElement>('input[role="combobox"]')!, "ঢাকার");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
    expect(sdk.getApiV1AdminCustomersSegments).toHaveBeenCalledTimes(1);
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount).not.toHaveBeenCalled();
  });

  it.each([false, true])("resolves a selected filter with one detail request (unavailable: %s)", async (unavailable) => {
    if (unavailable) sdk.getApiV1AdminCustomersSegmentsBySegmentId.mockRejectedValueOnce(new Error("Not found"));
    await render(<CustomerListFilters search={validate({ segmentId: "seg_0" })} />);
    expect(button(c("filterSegment")).textContent).toContain(unavailable ? c("segmentUnavailable") : "Segment 1");
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentId).toHaveBeenCalledTimes(1);
    expect(sdk.getApiV1AdminCustomersSegments).not.toHaveBeenCalled();
    expect(sdk.getApiV1AdminCustomersSegmentsBySegmentIdCount).not.toHaveBeenCalled();
  });
});
