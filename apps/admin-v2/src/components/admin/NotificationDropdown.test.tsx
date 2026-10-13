// @vitest-environment happy-dom
import { act, StrictMode, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationDropdown } from "./NotificationDropdown";
import { setLocale } from "~/i18n";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { StaffAlertItem, StaffAlertPage, StaffAlertSummary } from "~/lib/api-query-options/staff-alerts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ feed: vi.fn(), summary: vi.fn(), read: vi.fn(), readAll: vi.fn(), clear: vi.fn(), undo: vi.fn(), navigate: vi.fn(), success: vi.fn(), error: vi.fn(), browserOn: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminNotifications: mocks.feed, getApiV1AdminNotificationsSummary: mocks.summary,
  postApiV1AdminNotificationsBySeqRead: mocks.read, postApiV1AdminNotificationsReadAll: mocks.readAll,
  postApiV1AdminNotificationsClearAll: mocks.clear, postApiV1AdminNotificationsClearAllUndo: mocks.undo,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ to, children, hash, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; hash?: string; children: ReactNode }) => <a href={`${to}${hash ? `#${hash}` : ""}`} {...props}>{children}</a>,
}));
vi.mock("~/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("~/lib/web-push", () => ({ pushBlocker: () => null, thisBrowserIsOn: mocks.browserOn }));

const envelope = <T,>(data: T) => ({ data: { success: true, data } });
const scope = (name: "orders" | "conversations" = "orders", revision = 0) => ({ scope: name, revision, readThrough: 0, clearedThrough: 0 });
const item = (seq: number, extra: Partial<StaffAlertItem> = {}): StaffAlertItem => ({
  seq, id: `alert_${seq}`, scope: "orders", kind: "order_created", subjectId: `order_${seq}`,
  occurredAt: "2026-10-12T00:00:00Z", orderNumber: String(seq), read: false, href: `/admin/orders/order_${seq}`, ...extra,
});
let saved: StaffAlertItem[];
let state: StaffAlertSummary;
let root: Root;
let client: QueryClient;
let host: HTMLDivElement;
let worker: EventTarget;
let descriptor: PropertyDescriptor | undefined;
function seed(items: StaffAlertItem[], scopes = [scope()], head = Math.max(0, ...items.map(({ seq }) => seq))) {
  saved = [...items].sort((a, b) => b.seq - a.seq);
  const unread = saved.filter(({ read }) => !read).length;
  state = { head, scopes, unreadCount: Math.min(99, unread), unreadCountCapped: unread > 99, countCap: 99 };
}
function page(beforeSeq?: number): StaffAlertPage {
  const rows = saved.filter((row) => (beforeSeq === undefined || row.seq < beforeSeq) && state.scopes.some(({ scope }) => scope === row.scope));
  return { ...state, items: rows.slice(0, 20), nextBefore: rows.length > 20 ? rows[19]!.seq : null };
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setLocale("en");
  seed([]);
  mocks.browserOn.mockResolvedValue(true);
  mocks.summary.mockImplementation(async () => envelope({ ...state }));
  mocks.feed.mockImplementation(async ({ query }: { query: { beforeSeq?: number } }) => envelope(page(query.beforeSeq)));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  worker = new EventTarget(); descriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
});
afterEach(() => {
  act(() => root.unmount()); client.clear(); host.remove();
  if (descriptor) Object.defineProperty(navigator, "serviceWorker", descriptor); else Reflect.deleteProperty(navigator, "serviceWorker");
  vi.restoreAllMocks(); setLocale("en");
});
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
async function render(userId: string | undefined = "staff_a") {
  await act(async () => root.render(<StrictMode><QueryClientProvider client={client}><NotificationDropdown userId={userId} /></QueryClientProvider></StrictMode>));
  await settle();
}
async function click(element: HTMLElement) { await act(async () => element.click()); await settle(); }
async function open() { await click(host.querySelector("button")!); }
function dialog() { return document.querySelector<HTMLElement>('[role="dialog"]')!; }
function button(text: string) {
  const result = [...dialog().querySelectorAll("button")].find((element) => element.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
function rows() { return [...dialog().querySelectorAll<HTMLButtonElement>("[data-notification-seq]")]; }
async function receipt() {
  await act(async () => worker.dispatchEvent(new MessageEvent("message", { data: { type: "scalius:push", title: "Device test must not become history", body: "Native receipt only" } })));
  await settle();
}
async function focus() { await act(async () => window.dispatchEvent(new Event("focus"))); await settle(); }
function undoAction() { return mocks.success.mock.calls.at(-1)![1].action.onClick as () => void; }

describe("server staff notification history", () => {
  it.each(["en", "bn"] as const)("keeps empty history quiet, ignores local receipts, and localizes capped unread in %s", async (locale) => {
    setLocale(locale);
    localStorage.setItem("scalius_admin_notifications:v2:staff_a", JSON.stringify([{ title: "Old untrusted receipt" }]));
    await render(); await open();
    expect(dialog().textContent).toContain(locale === "en" ? "No alerts yet." : "এখনো কোনো নোটিফিকেশন নেই।");
    expect(dialog().querySelectorAll("button")).toHaveLength(0);
    seed(Array.from({ length: 120 }, (_, index) => item(index + 1)));
    await receipt();
    expect(host.querySelector("button")!.getAttribute("aria-label")).toBe(locale === "en" ? "Notifications (99+ unread)" : "নোটিফিকেশন (৯৯+ পড়া হয়নি)");
    expect(rows()).toHaveLength(0);
    await click(button(locale === "en" ? "New alerts" : "নতুন নোটিফিকেশন"));
    expect(rows()).toHaveLength(20);
    expect(dialog().textContent).not.toContain("Old untrusted receipt");
    expect(dialog().textContent).not.toContain("Device test must not become history");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("refreshes this browser's setup note when reopening the persistent bell", async () => {
    mocks.browserOn.mockResolvedValue(false);
    await render();
    expect(mocks.browserOn).not.toHaveBeenCalled();
    await open();
    expect(dialog().textContent).toContain("Off in this browser");
    expect(dialog().querySelector('a[href="/admin/account#this-device"]')).not.toBeNull();
    await open();
    mocks.browserOn.mockResolvedValue(true);
    await open();
    expect(dialog().textContent).not.toContain("Browser alerts");
    await open();
    mocks.browserOn.mockResolvedValue(false);
    await open();
    expect(dialog().textContent).toContain("Off in this browser");
    expect(mocks.browserOn).toHaveBeenCalledTimes(3);
  });

  it("distinguishes loading and failed reads from an empty history and retries", async () => {
    let finish!: (value: ReturnType<typeof envelope<StaffAlertPage>>) => void;
    mocks.feed.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(); await open();
    expect(dialog().querySelector('[role="status"]')?.textContent).toBe("Loading notifications…");
    expect(dialog().textContent).not.toContain("No alerts yet.");
    await act(async () => finish(envelope(page()))); await settle();
    mocks.feed.mockRejectedValueOnce(new Error("offline"));
    await focus();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Couldn't load notifications.");
    expect(dialog().textContent).not.toContain("No alerts yet.");
    await click(button("Try again"));
    expect(dialog().textContent).toContain("No alerts yet.");
  });

  it("wraps full labels, disables invalid destinations, and sends a read receipt when opening a logical resource", async () => {
    seed([item(1, { href: "https://elsewhere.test/private", orderNumber: "1234567890".repeat(20) })]);
    mocks.read.mockImplementation(async () => { seed([item(1, { read: true })], [scope("orders", 1)]); return envelope({ summary: state }); });
    await render(); await open(); await click(rows()[0]!);
    expect(rows()[0]!.disabled).toBe(true);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(rows()[0]!.getAttribute("aria-expanded")).toBeNull();
    expect(rows()[0]!.textContent).toContain("1234567890".repeat(20));
    expect(rows()[0]!.getAttribute("aria-label")).toBeNull();
    expect(rows()[0]!.querySelector(".truncate, .line-clamp-2")).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
    seed([item(1)]); await focus(); await click(rows()[0]!);
    expect(mocks.read.mock.calls[0]![0].path).toEqual({ seq: 1 });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/admin/orders/order_1" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("bounds mounted history at 100 and seeks older pages without losing the opening frontier", async () => {
    seed(Array.from({ length: 125 }, (_, index) => item(index + 1)));
    await render(); await open();
    for (let index = 0; index < 5; index++) await click(button("Load older"));
    expect(rows()).toHaveLength(100);
    expect(rows()[0]!.dataset.notificationSeq).toBe("105");
    expect(mocks.feed.mock.calls.at(-1)![0].query).toEqual({ limit: 20, beforeSeq: 26 });
    expect(button("Back to newest")).toBeTruthy();
    mocks.clear.mockResolvedValueOnce(envelope({ summary: { ...state, unreadCount: 0 } }));
    await click(button("Clear all"));
    expect(mocks.clear.mock.calls[0]![0].body.through).toBe(125);
  });

  it("keeps the current window on push and focus, then explicitly loads new arrivals", async () => {
    seed([item(2), item(1)]); await render(); await open();
    const scroller = dialog().querySelector<HTMLDivElement>(".overflow-y-auto")!;
    scroller.scrollTop = 42;
    seed(Array.from({ length: 140 }, (_, index) => item(index + 1)));
    await receipt(); await focus();
    expect(rows().map((row) => row.dataset.notificationSeq)).toEqual(["2", "1"]);
    expect(scroller.scrollTop).toBe(42);
    expect(mocks.feed.mock.calls.at(-1)![0].query.beforeSeq).toBe(3);
    await click(button("New alerts"));
    expect(rows()[0]!.dataset.notificationSeq).toBe("140");
    expect(mocks.feed.mock.calls.at(-1)![0].query.beforeSeq).toBeUndefined();
  });

  it("marks read only through the shown frontier and scopes, retaining history", async () => {
    seed([item(2), item(1, { scope: "conversations", kind: "conversation_message" })], [scope(), scope("conversations")]);
    await render(); await open(); seed([item(3), ...saved], state.scopes); await receipt();
    mocks.readAll.mockImplementation(async () => { seed(saved.map((row) => ({ ...row, read: row.seq <= 2 })), state.scopes); return envelope({ summary: state }); });
    await click(button("Mark all read"));
    expect(mocks.readAll.mock.calls[0]![0].body).toEqual({ through: 2, scopes: ["orders", "conversations"] });
    expect(rows()).toHaveLength(3);
    expect(rows()[0]!.textContent).toContain("Unread:");
    expect(rows()[1]!.textContent).not.toContain("Unread:");
    expect(document.activeElement).toBe(dialog());
  });

  it("sends Clear all revisions and the returned Undo token without clearing new arrivals", async () => {
    seed([item(2), item(1)], [scope("orders", 7)]); await render(); await open();
    const undo = { operationId: "clear_receipt", scopes: [{ scope: "orders", revision: 8 }] };
    mocks.clear.mockImplementation(async () => { seed([item(3)], [scope("orders", 8)]); return envelope({ summary: state, undo }); });
    await click(button("Clear all"));
    expect(mocks.clear.mock.calls[0]![0].body).toMatchObject({ through: 2, scopes: [{ scope: "orders", revision: 7 }] });
    expect(mocks.clear.mock.calls[0]![0].body.operationId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(rows().map((row) => row.dataset.notificationSeq)).toEqual(["3"]);
    mocks.undo.mockImplementation(async () => { seed([item(3), item(2), item(1)], [scope("orders", 9)]); return envelope({ summary: state }); });
    await act(async () => undoAction()()); await settle();
    expect(mocks.undo.mock.calls[0]![0].body).toEqual(undo);
    expect(rows()).toHaveLength(3);
    expect(rows()[0]!.textContent).toContain("Unread:");
  });

  it("does not let a summary read started before Clear all restore cleared unread alerts", async () => {
    seed([item(1)], [scope("orders", 7)]); await render(); await open();
    const beforeClear = structuredClone(state);
    let finish!: (value: ReturnType<typeof envelope<StaffAlertSummary>>) => void;
    mocks.summary.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await focus();
    mocks.clear.mockImplementation(async () => {
      seed([item(2)], [scope("orders", 8)]);
      return envelope({ summary: state });
    });
    await click(button("Clear all"));
    expect(client.getQueryData<StaffAlertSummary>(["staff-alerts", "staff_a", "summary"])?.scopes[0]?.revision).toBe(8);
    await act(async () => finish(envelope(beforeClear))); await settle();
    expect(client.getQueryData<StaffAlertSummary>(["staff-alerts", "staff_a", "summary"])).toEqual(state);
    expect(rows().map((row) => row.dataset.notificationSeq)).toEqual(["2"]);
    seed([item(3), item(2)], [scope("orders", 8)]);
    await focus();
    expect(client.getQueryData<StaffAlertSummary>(["staff-alerts", "staff_a", "summary"])).toEqual(state);
    expect(button("New alerts")).toBeTruthy();
  });

  it("retries an ambiguous Clear all with the identical operation ID and immutable body", async () => {
    seed([item(1)], [scope("orders", 4)]); await render(); await open();
    mocks.clear.mockRejectedValueOnce(new TypeError("response lost")).mockResolvedValueOnce(envelope({ summary: state }));
    await click(button("Clear all"));
    const original = structuredClone(mocks.clear.mock.calls[0]![0].body);
    expect(rows()).toHaveLength(1);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Couldn't update notifications. Try again.");
    await click(button("Try again"));
    expect(mocks.clear.mock.calls[1]![0].body).toEqual(original);
  });

  it("keeps CAS errors visible and never fabricates a clear or undo success", async () => {
    seed([item(1)], [scope("orders", 3)]); await render(); await open();
    mocks.clear.mockRejectedValueOnce(new AdminApiResponseError("conflict", 409));
    await click(button("Clear all"));
    expect(rows()).toHaveLength(1); expect(mocks.success).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("Notifications changed. Reload before clearing them.");
    await click(button("Try again")); expect(mocks.clear).toHaveBeenCalledTimes(1);
    const undo = { operationId: "clear_token", scopes: [{ scope: "orders", revision: 4 }] };
    mocks.clear.mockResolvedValueOnce(envelope({ summary: state, undo })); await click(button("Clear all"));
    await open(); // Close the open bell before an old toast's action.
    mocks.undo.mockRejectedValueOnce(new AdminApiResponseError("conflict", 409));
    await act(async () => undoAction()()); await settle();
    expect(mocks.error).toHaveBeenCalledWith("Notifications changed since you cleared them. Reload to see the latest list.");
    await open(); expect(dialog().textContent).toContain("Notifications changed since you cleared them.");
  });

  it("drops revoked scope rows on focus and starts fresh when the bell reopens", async () => {
    seed([item(2), item(1, { scope: "conversations", kind: "conversation_message" })], [scope(), scope("conversations")]);
    await render(); await open(); expect(rows()).toHaveLength(2);
    state = { ...state, scopes: [scope("conversations")] }; await focus();
    expect(rows().map((row) => row.dataset.notificationSeq)).toEqual(["1"]);
    await open(); seed([item(3, { scope: "conversations", kind: "conversation_message" })], state.scopes); await open();
    expect(rows().map((row) => row.dataset.notificationSeq)).toEqual(["3"]);
  });

  it("never renders another account's cached history and invalidates old Undo callbacks", async () => {
    seed([item(1)]); await render(); await open();
    mocks.clear.mockResolvedValueOnce(envelope({ summary: state, undo: { operationId: "old_account", scopes: [{ scope: "orders", revision: 1 }] } }));
    await click(button("Clear all")); const oldUndo = undoAction();
    seed([item(90)]); await render("staff_b"); expect(document.querySelector('[role="dialog"]')).toBeNull(); await open();
    expect(rows().map((row) => row.dataset.notificationSeq)).toEqual(["90"]);
    await act(async () => oldUndo()); expect(mocks.undo).not.toHaveBeenCalled();
    const before = mocks.summary.mock.calls.length;
    await render(""); await open(); expect(rows()).toHaveLength(0); expect(mocks.summary).toHaveBeenCalledTimes(before);
  });

  it("retains loaded rows after an older-page failure and retries the same cursor", async () => {
    seed(Array.from({ length: 25 }, (_, index) => item(index + 1))); await render(); await open();
    mocks.feed.mockRejectedValueOnce(new Error("offline")); await click(button("Load older"));
    expect(rows()).toHaveLength(20); expect(dialog().textContent).toContain("Couldn't load older notifications.");
    await click(button("Try again")); expect(rows()).toHaveLength(25);
    expect(mocks.feed.mock.calls.at(-1)![0].query.beforeSeq).toBe(6);
  });

  it("ignores a previous account's in-flight mutation after switching accounts", async () => {
    seed([item(1)]); await render(); await open();
    let finish!: (value: ReturnType<typeof envelope<{ summary: StaffAlertSummary }>>) => void;
    mocks.clear.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await click(button("Clear all"));
    const old = state;
    seed([item(90)]); await render("staff_b"); await open();
    await act(async () => finish(envelope({ summary: old }))); await settle();
    expect(rows().map((row) => row.dataset.notificationSeq)).toEqual(["90"]);
    expect(client.getQueryData<StaffAlertSummary>(["staff-alerts", "staff_b", "summary"])?.head).toBe(90);
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
