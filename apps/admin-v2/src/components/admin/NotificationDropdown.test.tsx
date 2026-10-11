// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationDropdown } from "./NotificationDropdown";
import { setLocale } from "~/i18n";
import { resetDashboardBasePathCache } from "~/lib/dashboard-base-path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), toast: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ to, children, hash, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; hash?: string; children: ReactNode }) => (
    <a href={`${to}${hash ? `#${hash}` : ""}`} {...props}>{children}</a>
  ),
}));
vi.mock("~/lib/toast", () => ({ toast: { success: mocks.toast } }));
vi.mock("~/lib/web-push", () => ({ pushBlocker: () => null, thisBrowserIsOn: async () => true }));

const key = (user = "staff_a") => `scalius_admin_notifications:v2:${user}`;
const notification = (id: string, timestamp = 1, read = false) => ({ id, title: `Title ${id}`, message: `Full body ${id}`, timestamp, read });
let root: Root;
let host: HTMLDivElement;
let worker: EventTarget;
let serviceWorkerDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setLocale("en");
  resetDashboardBasePathCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  worker = new EventTarget();
  serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (serviceWorkerDescriptor) Object.defineProperty(navigator, "serviceWorker", serviceWorkerDescriptor);
  else Reflect.deleteProperty(navigator, "serviceWorker");
  vi.restoreAllMocks();
  document.head.querySelector('meta[name="scalius-dashboard-base-path"]')?.remove();
  resetDashboardBasePathCache();
  setLocale("en");
});
async function render(userId: string | undefined = "staff_a") {
  await act(async () => root.render(<StrictMode><NotificationDropdown userId={userId} /></StrictMode>));
}
async function click(button: HTMLElement) { await act(async () => button.click()); }
async function open() { await click(host.querySelector("button")!); }
function dialog() { return document.querySelector<HTMLElement>('[role="dialog"]')!; }
function button(text: string) {
  const result = [...dialog().querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
function rows() { return [...dialog().querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]; }
function saved(user = "staff_a") { return JSON.parse(localStorage.getItem(key(user)) ?? "[]"); }
async function push(data: unknown) { await act(async () => worker.dispatchEvent(new MessageEvent("message", { data }))); }
const receipt = (id: string, at = 1) => ({ type: "scalius:push", id, at, title: `Title ${id}`, body: `Full body ${id}` });
function undo() { return mocks.toast.mock.calls.at(-1)?.[1].action.onClick as () => void; }

describe("browser notification receipts", () => {
  it.each(["en", "bn"] as const)("renders empty, few and bounded-many lists in %s without reading them on open", async (locale) => {
    setLocale(locale);
    await render();
    await open();
    expect(rows()).toHaveLength(0);
    expect(dialog().textContent).toContain(locale === "en" ? "No alerts yet." : "এখনো কোনো নোটিফিকেশন নেই।");
    expect(dialog().textContent).toContain(locale === "en" ? "last 50" : "সর্বশেষ ৫০টি");
    expect(dialog().querySelectorAll("button")).toHaveLength(0);
    for (let i = 1; i <= 60; i += 1) {
      await push(receipt(String(i), i));
      if (i <= 4) expect(rows()).toHaveLength(i);
    }
    expect(rows()).toHaveLength(50);
    expect(rows()[0]?.textContent).toContain("Title 60");
    expect(rows().at(-1)?.textContent).toContain("Title 11");
    expect(saved()).toHaveLength(50);
    expect(saved().every((item: { read: boolean }) => !item.read)).toBe(true);
    expect(rows()[0]?.textContent).toContain(locale === "en" ? "Unread:" : "পড়া হয়নি:");
    expect(rows()[0]?.getAttribute("aria-label")).toBeNull();
    expect(rows()[0]?.textContent).toContain("Full body 60");
  });

  it("dedupes worker receipts without undoing a read and writes once per event in StrictMode", async () => {
    await render();
    const setItem = vi.spyOn(localStorage, "setItem");
    await push(receipt("one"));
    expect(setItem).toHaveBeenCalledTimes(1);
    await open();
    expect(rows()).toHaveLength(1);
    await click(rows()[0]!);
    expect(rows()[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(rows()[0]?.querySelector(".line-clamp-2")).toBeNull();
    expect(rows()[0]?.querySelector(".truncate")).toBeNull();
    await push(receipt("one"));
    await push(receipt("two", 2));
    expect(saved()).toEqual([notification("two", 2), notification("one", 1, true)]);
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Notifications (1 unread)");
  });

  it("clears only read items, then Undo merges around receipts and changes from other tabs", async () => {
    localStorage.setItem(key(), JSON.stringify([notification("read", 1, true), notification("unread", 2)]));
    await render();
    await open();
    // Another tab writes after this tab rendered, before its clear action.
    localStorage.setItem(key(), JSON.stringify([...saved(), notification("other-tab", 3)]));
    await click(button("Clear read"));
    expect(saved().map((item: { id: string }) => item.id)).toEqual(["other-tab", "unread"]);
    expect(document.activeElement).toBe(dialog());
    expect(mocks.toast).toHaveBeenCalledWith("Read notifications cleared", expect.objectContaining({ duration: 10_000, action: expect.objectContaining({ label: "Undo" }) }));
    await push(receipt("arrived-after-clear", 4));
    await act(async () => undo()());
    expect(saved().map((item: { id: string }) => item.id)).toEqual(["arrived-after-clear", "other-tab", "unread", "read"]);
    await click(button("Mark all read"));
    expect(saved().every((item: { read: boolean }) => item.read)).toBe(true);
    await click(button("Clear read"));
    expect(rows()).toHaveLength(0);
    expect(dialog().textContent).toContain("No alerts yet.");
  });

  it("syncs same-account storage events and ignores other accounts", async () => {
    await render();
    await open();
    localStorage.setItem(key(), JSON.stringify([notification("synced", 2, true)]));
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: key("staff_b") })));
    expect(rows()).toHaveLength(0);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: key() })));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).not.toContain("Unread:");
    localStorage.removeItem(key());
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(rows()).toHaveLength(0);
  });

  it("never shows an old account or legacy list, and ignores its old Undo after switching", async () => {
    const legacy = JSON.stringify([notification("unknown-owner")]);
    localStorage.setItem("scalius_admin_notifications", legacy);
    localStorage.setItem(key(), JSON.stringify([notification("account-a", 1, true)]));
    localStorage.setItem(key("staff_b"), JSON.stringify([notification("account-b", 2)]));
    await render();
    await open();
    await click(button("Clear read"));
    const oldUndo = undo();
    await render("staff_b");
    expect(document.body.textContent).not.toContain("account-a");
    await open();
    expect(rows()[0]?.textContent).toContain("account-b");
    await act(async () => oldUndo());
    expect(saved()).toEqual([]);
    expect(saved("staff_b")).toHaveLength(1);
    expect(localStorage.getItem("scalius_admin_notifications")).toBe(legacy);
    await act(async () => root.render(<NotificationDropdown />));
    await open();
    await push(receipt("unknown-account"));
    expect(rows()).toHaveLength(0);
    expect(saved("staff_b")).toHaveLength(1);
  });

  it("validates tampered storage, dates and links before rendering or navigating", async () => {
    localStorage.setItem(key(), JSON.stringify([
      null, { ...notification("bad-read"), read: "false" }, { ...notification("bad-time"), timestamp: 1e50 },
      { ...notification("bad-body"), message: {} }, { ...notification("empty-title"), title: " " },
      { ...notification("offsite", 4), link: "//evil.example" },
      { ...notification("backslash", 3), link: "/\\evil.example" },
      { ...notification("absolute", 2), link: `${window.location.origin}/admin/orders` },
      { ...notification("good", 1), link: "/admin/orders" },
    ]));
    await render();
    await open();
    expect(rows()).toHaveLength(3);
    await click(rows()[0]!);
    expect(mocks.navigate).not.toHaveBeenCalled();
    const linked = [...dialog().querySelectorAll("button")].find((item) => item.textContent?.includes("Title good"))!;
    await click(linked);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/admin/orders" });
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("rejects malformed worker fields and safely converts same-origin absolute links", async () => {
    await render();
    for (const data of [null, { ...receipt("bad"), id: {} }, { ...receipt("bad"), at: 1e50 }, { ...receipt("bad"), title: " " }, { ...receipt("bad"), body: {} }]) await push(data);
    expect(saved()).toHaveLength(0);
    await push({ ...receipt("good"), url: `${window.location.origin}/admin/orders?view=open#latest` });
    expect(saved()[0].link).toBe("/admin/orders?view=open#latest");
    await push({ ...receipt("offsite", 2), url: "https://evil.example/admin/orders" });
    expect(saved()[0].link).toBeUndefined();
    await push({ type: "scalius:push", title: "Older worker", body: "During rollout" });
    expect(saved()[0]).toMatchObject({ id: expect.any(String), timestamp: expect.any(Number), title: "Older worker" });
  });

  it.each([["/dashboard/admin/orders?view=open#latest", "/admin/orders?view=open#latest"], ["/dashboard?view=open", "/?view=open"]])("strips the dashboard prefix once when navigating %s", async (path, route) => {
    const meta = document.createElement("meta");
    meta.name = "scalius-dashboard-base-path";
    meta.content = "/dashboard";
    document.head.append(meta);
    await render();
    await push({ ...receipt("prefixed"), url: `${window.location.origin}${path}` });
    await open();
    const linked = [...dialog().querySelectorAll("button")].find((item) => item.textContent?.includes("Title prefixed"))!;
    await click(linked);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: route });
    expect(saved()[0].link).toBe(path);
  });

  it("keeps consecutive receipts in memory when storage writes are blocked", async () => {
    await render();
    const blockedWrite = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await push(receipt("first", 1));
    await push(receipt("second", 2));
    expect(blockedWrite).toHaveBeenCalledTimes(2);
    expect(saved()).toHaveLength(0);
    await open();
    expect(rows()).toHaveLength(2);
    await click(button("Mark all read"));
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Notifications");
  });
});
