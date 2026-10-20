// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { orderTimelineMessages } from "~/i18n/order-timeline";
import { resourceMessages } from "~/i18n/resource";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { OrderTimelineCard } from "./OrderTimelineCard";
import type { Order } from "./types";

const mocks = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn() }));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (value: number) => `৳${value}` }) }));
vi.mock("~/hooks/use-order-action-permissions", () => ({ useOrderActionPermissions: () => ({ canEditOrders: true }) }));
vi.mock("~/lib/api-query-options/orders", () => ({
  orderTimelineWindowOptions: (id: string, cursor: string | null = null) => ({
    queryKey: ["orders", "timeline", id, "window", cursor], initialPageParam: cursor,
    queryFn: ({ pageParam }: { pageParam: string | null }) => mocks.read(id, pageParam),
    getNextPageParam: (page: { nextCursor: string | null }) => page.nextCursor ?? undefined, maxPages: 2,
  }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useAddOrderComment: () => ({ mutate: mocks.post, reset: vi.fn(), isPending: false, isError: false }),
  useDeleteOrderComment: () => ({ mutate: vi.fn(), isPending: false }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function page(id = "A", cursor: string | null = null) {
  const offset = Number(cursor ?? 0);
  const events = Array.from({ length: Math.min(50, 205 - offset) }, (_, index) => ({
    id: `${id}_${205 - offset - index}`, kind: "comment", body: `Saved ${205 - offset - index}`,
    data: null, actorName: "Staff", own: false, createdAt: "2026-10-01T00:00:00.000Z",
  }));
  const nextCursor = offset + 50 < 205 ? String(offset + 50) : null;
  if (!nextCursor) events.push({ id: `placed_${id}`, kind: "placed", body: "", data: null, actorName: "Staff", own: false, createdAt: "2026-01-01T00:00:00.000Z" });
  return { events, nextCursor, hasMore: nextCursor !== null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("bounded order timeline history", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    setLocale("en");
    mocks.read.mockImplementation(async (id: string, cursor: string | null) => page(id, cursor));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const id of ["A", "B"]) client.setQueryData(["orders", "timeline", id, "window", null], { pages: [page(id)], pageParams: [null] });
  });
  afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); setLocale("en"); });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  async function render(id = "A") {
    await act(async () => root.render(<QueryClientProvider client={client}><OrderTimelineCard order={{ id, items: [], totalAmount: 100, currencyCode: "BDT" } as unknown as Order} /></QueryClientProvider>));
    await settle();
  }
  const rows = () => Array.from(host.querySelectorAll<HTMLElement>("[data-timeline-event]"));
  const ids = () => rows().map((row) => row.dataset.timelineEvent);
  const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((el) => el.getAttribute("aria-label") === label || el.textContent === label)!;
  async function click(label: string) {
    const target = button(label); expect(target).toBeTruthy();
    await act(async () => { target.focus(); target.click(); }); await settle();
    return target;
  }

  it.each(["en", "bn"] as const)("keeps every one of 205 events reachable in bounded windows (%s)", async (locale) => {
    setLocale(locale); const t = orderTimelineMessages[locale];
    await render();
    expect(rows()).toHaveLength(50); expect(ids()).not.toContain("placed_A");
    const observed = new Set(ids());
    await click(t["timeline.loadOlder"]);
    expect(rows()).toHaveLength(100); ids().forEach((id) => observed.add(id));
    expect(document.activeElement?.getAttribute("data-timeline-event")).toBe("A_155");
    await click(t["timeline.older"]);
    expect(rows()).toHaveLength(50); expect(ids()[0]).toBe("A_105"); ids().forEach((id) => observed.add(id));
    await click(t["timeline.loadOlder"]);
    expect(rows()).toHaveLength(100); ids().forEach((id) => observed.add(id));
    await click(t["timeline.older"]);
    expect(ids()).toEqual(["A_5", "A_4", "A_3", "A_2", "A_1", "placed_A"]); ids().forEach((id) => observed.add(id));
    expect(observed.size).toBe(206);
    expect(button(t["timeline.loadOlder"])).toBeUndefined();
    await click(t["timeline.newer"]); expect(ids()[0]).toBe("A_105"); expect(rows()).toHaveLength(100);
    await click(t["timeline.older"]); expect(ids()[0]).toBe("A_5");
    await click(t["timeline.newest"]); expect(ids()[0]).toBe("A_205");
    expect(host.querySelector('[role="status"]')?.textContent).not.toBe("");
  });

  it("keeps the busy trigger named/focused, blocks duplicate loads, and respects later composer focus", async () => {
    await render();
    const pending = deferred<ReturnType<typeof page>>(); mocks.read.mockImplementationOnce(() => pending.promise);
    const trigger = await click(orderTimelineMessages.en["timeline.loadOlder"]);
    expect(trigger.disabled).toBe(false); expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.getAttribute("aria-label")).toBe("Load older"); expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click()); expect(mocks.read).toHaveBeenCalledTimes(1);
    const input = host.querySelector("textarea")!; input.focus();
    await act(async () => pending.resolve(page("A", "50"))); await settle();
    expect(rows()).toHaveLength(100); expect(document.activeElement).toBe(input);
  });

  it("retains visible rows on append and replacement errors, retrying the same boundary", async () => {
    await render();
    mocks.read.mockRejectedValueOnce(new Error("temporary"));
    await click("Load older"); expect(rows()).toHaveLength(50); expect(ids()[0]).toBe("A_205");
    await click(resourceMessages.en.retry); expect(rows()).toHaveLength(100);
    mocks.read.mockRejectedValueOnce(new Error("temporary"));
    await click("Older events"); expect(rows()).toHaveLength(100); expect(ids()[0]).toBe("A_205");
    await click(resourceMessages.en.retry); expect(ids()[0]).toBe("A_105");
    expect(mocks.read.mock.calls.slice(-2).map(([, cursor]) => cursor)).toEqual(["100", "100"]);
  });

  it.each(["en", "bn"] as const)("shows one recovery action during a delayed append retry (%s)", async (locale) => {
    setLocale(locale); const t = orderTimelineMessages[locale]; const retryLabel = resourceMessages[locale].retry;
    await render();
    mocks.read.mockRejectedValueOnce(new Error("temporary"));
    await click(t["timeline.loadOlder"]);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const pending = deferred<ReturnType<typeof page>>();
    mocks.read.mockImplementationOnce(() => pending.promise);
    const trigger = await click(retryLabel);
    expect(rows()).toHaveLength(50); expect(ids()[0]).toBe("A_205");
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.getAttribute("aria-label")).toBe(t["timeline.loadOlder"]);
    expect(document.activeElement).toBe(trigger);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button(retryLabel)).toBeUndefined();
    await act(async () => trigger.click()); expect(mocks.read).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(page("A", "50"))); await settle();
    expect(rows()).toHaveLength(100);
    expect(document.activeElement?.getAttribute("data-timeline-event")).toBe("A_155");
    expect(mocks.read.mock.calls.map(([, cursor]) => cursor)).toEqual(["50", "50"]);
  });

  it.each(["Newer events", "Newest events"])("keeps %s failure and retry on the same focused button", async (label) => {
    await render(); await click("Load older"); await click("Older events"); await click("Load older"); await click("Older events");
    expect(ids().at(-1)).toBe("placed_A");
    mocks.read.mockRejectedValueOnce(new Error("temporary"));
    const trigger = await click(label);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-label")).toBe(resourceMessages.en.retry);
    const pending = deferred<ReturnType<typeof page>>();
    mocks.read.mockImplementationOnce(() => pending.promise);
    const retry = await click(resourceMessages.en.retry);
    expect(retry).toBe(trigger); expect(document.activeElement).toBe(trigger);
    expect(trigger.disabled).toBe(false); expect(trigger.getAttribute("aria-busy")).toBe("true");
    await act(async () => pending.resolve(page("A", label === "Newer events" ? "100" : null))); await settle();
    expect(document.activeElement?.getAttribute("data-timeline-event")).toBe(label === "Newer events" ? "A_105" : "A_205");
  });

  it("does not apply a pending navigation or its focus after switching order A → B → A", async () => {
    await render(); await click("Load older");
    const pending = deferred<ReturnType<typeof page>>(); mocks.read.mockImplementationOnce(() => pending.promise);
    await click("Older events"); await render("B"); expect(ids()[0]).toBe("B_205");
    await render("A"); const input = host.querySelector("textarea")!; input.focus();
    await act(async () => pending.resolve(page("A", "100"))); await settle();
    expect(ids()[0]).toBe("A_205"); expect(document.activeElement).toBe(input);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("offers a fresh newest window after an invalid cursor, retaining the current rows", async () => {
    await render(); await click("Load older"); await click("Older events"); await click("Load older");
    mocks.read.mockRejectedValueOnce(new AdminApiResponseError("Old cursor", 400, "INVALID_CURSOR"));
    await click("Older events"); expect(ids()[0]).toBe("A_105"); expect(rows()).toHaveLength(100);
    await click("Newest events"); expect(ids()[0]).toBe("A_205");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("returns to the newest window after a successful own comment", async () => {
    await render(); await click("Load older"); await click("Older events"); expect(ids()[0]).toBe("A_105");
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "A new note");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await act(async () => mocks.post.mock.calls[0]![1].onSuccess()); await settle();
    expect(ids()[0]).toBe("A_205"); expect(input.value).toBe("");
  });
});
