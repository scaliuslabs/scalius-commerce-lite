// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import type { StaffMessage, StaffThread } from "~/lib/api-query-options/inbox";

const older = vi.hoisted(() => vi.fn());
const around = vi.hoisted(() => vi.fn());
vi.mock("~/lib/api-query-options/inbox", () => ({ fetchOlderMessages: older, fetchMessagesAround: around }));
vi.mock("./inbox-api", () => ({ attachmentUrl: (thread: string, image: string) => `/private/${thread}/${image}` }));
import { ConversationMessages } from "./ConversationMessages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = inboxMessages.en;
function page(id: string, first: number, last: number, hasMore = first > 1): StaffThread {
  const messages: StaffMessage[] = Array.from({ length: last - first + 1 }, (_, index) => ({
    id: `${id}_${first + index}`, seq: first + index, kind: "message", visibility: "public", authorType: "customer",
    authorUserId: null, authorName: null, body: `${id} message ${first + index}`, eventKind: null, eventData: null,
    createdAt: 1_780_000_000 + first + index, attachments: [],
  }));
  return { id, subjectType: "store", subjectId: null, subject: "Question", status: "open", orderId: null,
    orderNumber: null, customerId: null, customerName: "Customer", assigneeUserId: null, assigneeName: null, assigneeEligible: false, lastMessageVisibility: "public",
    lastMessageAt: 1_780_000_000 + last, lastAuthorType: "customer", preview: null, unread: 0, version: 1,
    lastSeq: last, staffReadSeq: 0, customerReadSeq: 0, hasMore, order: null, cases: [], messages };
}
function deferred() {
  let resolve!: (value: StaffThread) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<StaffThread>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;
let resized: (() => void) | undefined;
const intersections: Array<{ emit: (visible?: boolean) => void; disconnected: boolean }> = [];
const tailVisible = (visible = true) => intersections.at(-1)!.emit(visible);
const region = () => host.querySelector<HTMLDivElement>('[role="region"]')!;
const rows = () => [...host.querySelectorAll<HTMLElement>("[data-message-seq]")];
const sequences = () => rows().map((row) => Number(row.dataset.messageSeq));
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => label === en.newMessages ? /new messages?/i.test(node.textContent ?? "") : node.textContent?.trim() === label)!;
const render = async (thread: StaffThread, props: Partial<ComponentProps<typeof ConversationMessages>> = {}) => act(async () => root.render(<ConversationMessages thread={thread} currentUserId="staff_1" className="overflow-y-auto" {...props} />));
const scroll = async (top: number) => act(async () => { region().scrollTop = top; region().dispatchEvent(new Event("scroll")); });

beforeEach(() => {
  older.mockReset();
  around.mockReset();
  intersections.length = 0;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("IntersectionObserver", class {
    target!: Element;
    disconnected = false;
    constructor(readonly callback: IntersectionObserverCallback) { intersections.push(this); }
    observe(target: Element) { this.target = target; }
    disconnect() { this.disconnected = true; }
    emit(visible = true) {
      this.callback([{ target: this.target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
  });
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // Deterministic geometry: rows are 20px high and the viewport is 200px.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.querySelectorAll("[data-message-seq]").length * 20;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[role="region"]');
    const index = owner ? [...owner.querySelectorAll("[data-message-seq]")].indexOf(this) : -1;
    return new DOMRect(0, index < 0 ? 0 : index * 20 - Math.min(owner!.scrollTop, Math.max(0, owner!.scrollHeight - owner!.clientHeight)), 320, index < 0 ? 200 : 20);
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(readonly callback: () => void) {}
    observe(target: Element) { if (target.matches('[role="region"]')) resized = this.callback; }
    disconnect() {}
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("conversation timeline continuity", () => {
  it("retains 120 loaded rows across overlapping latest-50 refreshes, sorted and deduplicated by sequence", async () => {
    await render(page("a", 71, 120));
    older.mockResolvedValueOnce(page("a", 21, 70)).mockResolvedValueOnce(page("a", 1, 20));
    await act(async () => button(en.loadOlder).click());
    await act(async () => button(en.loadOlder).click());
    await render(page("a", 72, 121));
    await render(page("a", 71, 120)); // A late/stale refresh cannot remove the already loaded new line.
    expect(sequences()).toEqual(Array.from({ length: 121 }, (_, index) => index + 1));
    expect(older.mock.calls).toEqual([["a", 71], ["a", 21]]);
    expect(button(en.loadOlder)).toBeUndefined();
  });

  it.each(["resolve", "reject"] as const)("ignores a stale older-page %s after A → B → A, without ending the new request", async (outcome) => {
    const stale = deferred();
    const current = deferred();
    older.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    await render(page("a", 51, 100));
    await act(async () => button(en.loadOlder).click());
    await render(page("b", 1, 3));
    expect(host.textContent).not.toContain("a message");
    await render(page("a", 51, 100));
    await act(async () => button(en.loadOlder).click());
    await act(async () => {
      if (outcome === "resolve") stale.resolve(page("a", 1, 50));
      else stale.reject(new Error("stale failure"));
    });
    expect(sequences()).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
    expect(button(en.loadOlder).getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => current.resolve(page("a", 1, 50)));
    expect(sequences()).toHaveLength(100);
    expect(button(en.loadOlder)).toBeUndefined();
  });

  it("preserves timeline keyboard focus across a keyed thread change without stealing outside focus", async () => {
    await render(page("a", 1, 3));
    region().focus();
    await render(page("b", 1, 3));
    expect(document.activeElement).toBe(region());
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      outside.focus();
      await render(page("c", 1, 3));
      expect(document.activeElement).toBe(outside);
    } finally { outside.remove(); }
  });

  it.each(["en", "bn"] as const)("shows a localized retry without leaking the rejected response on %s", async (locale) => {
    setLocale(locale);
    const copy = inboxMessages[locale];
    older.mockRejectedValueOnce(new Error("private response body must not render")).mockResolvedValueOnce(page("a", 1, 50));
    await render(page("a", 51, 100));
    await act(async () => button(copy.loadOlder).click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.loadOlderFailed);
    expect(host.textContent).not.toContain("private response");
    const retry = button(copy.retry);
    expect(retry.getAttribute("aria-label")).toBe(copy.retry);
    await act(async () => { retry.focus(); retry.click(); });
    expect(older.mock.calls).toEqual([["a", 51], ["a", 51]]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(sequences()).toHaveLength(100);
    expect(document.activeElement).toBe(region());
  });

  it("keeps a reader's position and focus on arrival, then jumps only when New messages is chosen", async () => {
    await render(page("a", 1, 50));
    await scroll(200);
    region().focus();
    await render(page("a", 2, 51));
    expect(region().scrollTop).toBe(200);
    expect(document.activeElement).toBe(region());
    const latest = button(en.newMessages);
    await act(async () => { latest.focus(); latest.click(); });
    expect(region().scrollTop).toBe(region().scrollHeight);
    expect(document.activeElement).toBe(region());
    expect(button(en.newMessages)).toBeUndefined();
  });

  it("follows the visible end across arrivals and resize, but does not follow after scrolling up", async () => {
    await render(page("a", 1, 50));
    await render(page("a", 2, 51));
    expect(region().scrollTop).toBe(region().scrollHeight);
    expect(button(en.newMessages)).toBeUndefined();
    region().scrollTop -= 10;
    await act(async () => resized?.());
    expect(region().scrollTop).toBe(region().scrollHeight);
    await scroll(200);
    await act(async () => resized?.());
    expect(region().scrollTop).toBe(200);
  });

  it("anchors the row visible when an older response arrives, preserving concurrent arrivals and reader movement", async () => {
    const pending = deferred();
    older.mockReturnValueOnce(pending.promise);
    await render(page("a", 51, 100));
    await scroll(200);
    await act(async () => button(en.loadOlder).click());
    await render(page("a", 52, 101));
    await scroll(240);
    await act(async () => pending.resolve(page("a", 1, 50)));
    expect(region().scrollTop).toBe(1240);
    expect(sequences()).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
    expect(button(en.newMessages)).toBeDefined();
  });

  it("commits a response-time prepend anchor before a same-task latest-window render", async () => {
    const pending = deferred();
    older.mockReturnValueOnce(pending.promise);
    await render(page("a", 51, 100));
    await scroll(240);
    await act(async () => button(en.loadOlder).click());
    await act(async () => {
      pending.resolve(page("a", 1, 50));
      await Promise.resolve(); // Older continuation has captured the current row.
      flushSync(() => root.render(<ConversationMessages thread={page("a", 52, 101)} currentUserId="staff_1" />));
    });
    expect(region().scrollTop).toBe(1240);
    expect(sequences()).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
  });

  it("places the new-message control after the timeline, away from the top load/retry controls", async () => {
    await render(page("a", 51, 100));
    await scroll(0);
    await render(page("a", 52, 101));
    const latest = button(en.newMessages).parentElement!;
    const earlier = button(en.loadOlder).parentElement!;
    expect(latest.classList.contains("bottom-0")).toBe(true);
    expect(latest.classList.contains("top-0")).toBe(false);
    expect(latest.previousElementSibling?.tagName).toBe("OL");
    expect(earlier.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region().scrollTop).toBe(0);
  });

  it.each([101, 121])("retains history and fills a gap before seq %i through bounded exclusive cursors with overlap", async (first) => {
    await render(page("a", 1, 50));
    await scroll(200);
    await render(page("a", first, first + 49));
    expect(sequences()).toHaveLength(100);
    expect(sequences().slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    older.mockImplementation((_id: string, beforeSeq: number) => Promise.resolve(page("a", Math.max(1, beforeSeq - 50), beforeSeq - 1)));
    await act(async () => button(en.loadOlder).click());
    if (first === 121) await act(async () => button(en.loadOlder).click());
    expect(older.mock.calls).toEqual(first === 101 ? [["a", 101]] : [["a", 121], ["a", 71]]);
    expect(sequences()).toEqual(Array.from({ length: first + 49 }, (_, index) => index + 1));
    expect(button(en.loadOlder)).toBeUndefined();
  });
  it("marks only a visible rendered tail, never a fetched frontier, hidden document, offscreen card or covered pane", async () => {
    const onReadFrontier = vi.fn();
    const data = { ...page("a", 1, 50), lastSeq: 80 };
    await render(data, { onReadFrontier });
    expect(onReadFrontier).not.toHaveBeenCalled();
    await act(async () => tailVisible(false));
    expect(onReadFrontier).not.toHaveBeenCalled();
    await act(async () => tailVisible());
    expect(onReadFrontier).toHaveBeenLastCalledWith(50);
    onReadFrontier.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => tailVisible());
    expect(onReadFrontier).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => tailVisible());
    expect(onReadFrontier).toHaveBeenLastCalledWith(50);
    onReadFrontier.mockClear();
    const stale = intersections.at(-1)!;
    await render(data, { onReadFrontier, active: false });
    await act(async () => stale.emit());
    expect(onReadFrontier).not.toHaveBeenCalled();
    await render(data, { onReadFrontier });
    host.setAttribute("aria-hidden", "true");
    await act(async () => tailVisible());
    expect(onReadFrontier).not.toHaveBeenCalled();
    host.removeAttribute("aria-hidden");
    await act(async () => tailVisible());
    expect(onReadFrontier).toHaveBeenLastCalledWith(50);
  });

  it("keeps a scrolled-up reader unread through a >50 arrival gap and ignores stale tail observations", async () => {
    const onReadFrontier = vi.fn();
    await render(page("a", 1, 50), { onReadFrontier });
    await act(async () => tailVisible());
    expect(onReadFrontier).toHaveBeenLastCalledWith(50);
    onReadFrontier.mockClear();
    await scroll(200);
    const stale = intersections.at(-1)!;
    await render(page("a", 121, 170), { onReadFrontier });
    await act(async () => { stale.emit(); tailVisible(false); });
    expect(onReadFrontier).not.toHaveBeenCalled();
    expect(region().scrollTop).toBe(200);
    expect(sequences()).toHaveLength(100);
    await act(async () => button(en.newMessages).click());
    expect(onReadFrontier).not.toHaveBeenCalled();
    await act(async () => tailVisible());
    expect(onReadFrontier).toHaveBeenLastCalledWith(170);
  });

  it("follows explicit local success only after its row is rendered, without taking composer focus", async () => {
    await render(page("a", 1, 50));
    await scroll(200);
    const arrived = page("a", 2, 51);
    Object.assign(arrived.messages.at(-1)!, { authorType: "staff", authorUserId: "staff_1" });
    await render(arrived);
    expect(region().scrollTop).toBe(200); // Another session of the same author is not a local send.
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    const followRequest = { conversationId: "a", seq: 52 };
    await render(arrived, { followRequest });
    expect(region().scrollTop).toBe(200);
    await render(page("a", 3, 52), { followRequest });
    expect(region().scrollTop).toBe(region().scrollHeight);
    expect(document.activeElement).toBe(input);
    await scroll(200);
    await render(page("a", 4, 53), { followRequest });
    expect(region().scrollTop).toBe(200); // A consumed success cannot follow again on a refresh.
    input.remove();
  });

  it("does not replay a pre-mount send request when loading older history later reveals its row", async () => {
    const onReadFrontier = vi.fn();
    const followRequest = { conversationId: "a", seq: 100 };
    await render(page("a", 51, 100), { followRequest, onReadFrontier });
    await render(page("b", 1, 3), { followRequest, onReadFrontier });
    await render(page("a", 151, 200), { followRequest, onReadFrontier });
    await scroll(200);
    older.mockResolvedValueOnce(page("a", 101, 150)).mockResolvedValueOnce(page("a", 51, 100));
    await act(async () => button(en.loadOlder).click());
    await act(async () => button(en.loadOlder).click());
    expect(region().scrollTop).toBe(2200);
    expect(region().scrollTop).toBeLessThan(region().scrollHeight - region().clientHeight);
    await act(async () => tailVisible(false));
    expect(onReadFrontier).not.toHaveBeenCalled();
  });

  it.each([["en", false], ["bn", true]] as const)("keeps its localized loading name and focus ownership in %s (moved=%s)", async (locale, moved) => {
    setLocale(locale);
    const label = inboxMessages[locale].loadOlder;
    const pending = deferred();
    older.mockReturnValueOnce(pending.promise);
    await render(page("a", 51, 100));
    const trigger = button(label);
    await act(async () => { trigger.focus(); trigger.click(); });
    expect(trigger.disabled).toBe(false); // Native disabled would blur the focused button before the response.
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.getAttribute("aria-label")).toBe(label);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    expect(older).toHaveBeenCalledTimes(1);
    const elsewhere = document.createElement("textarea");
    document.body.append(elsewhere);
    try {
      if (moved) elsewhere.focus();
      await act(async () => pending.resolve(page("a", 1, 50)));
      expect(button(label)).toBeUndefined();
      expect(document.activeElement).toBe(moved ? elsewhere : region());
    } finally { elsewhere.remove(); }
  });

});


it("keeps 500-line history navigable with at most 200 mounted rows and an explicit return to newest", async () => {
  await render(page("a", 451, 500));
  for (let end = 450; end >= 50; end -= 50) {
    older.mockResolvedValueOnce(page("a", end - 49, end));
    await act(async () => button(en.loadOlder).click());
    expect(rows().length).toBeLessThanOrEqual(200);
  }
  expect(sequences()[0]).toBe(1);
  expect(button(en.loadOlder)).toBeUndefined();
  await act(async () => button(en.backNewest).click());
  expect(sequences()).toEqual(Array.from({ length: 50 }, (_, index) => index + 451));
  expect(button(en.loadOlder)).toBeDefined();
});

it("find highlights the selected window without stealing focus and keeps the inspected position on close", async () => {
  await render(page("a", 451, 500));
  await scroll(320);
  const input = document.createElement("input"); host.append(input); input.focus();
  const pending = deferred();
  around.mockReturnValueOnce(pending.promise);
  const request = { seq: 75, serial: 1 };
  await render(page("a", 451, 500), { finding: true, findRequest: request });
  await act(async () => pending.resolve(page("a", 50, 99)));
  expect(sequences()).toHaveLength(50);
  expect(sequences()).toContain(75);
  expect(document.activeElement).toBe(input);
  expect(host.querySelector('[data-message-seq="75"]')?.getAttribute("aria-current")).toBe("true");
  await scroll(360);
  await render(page("a", 451, 500), { finding: false, findRequest: request });
  expect(sequences()[0]).toBe(50);
  expect(region().scrollTop).toBe(360);
  expect(host.querySelector("[aria-current]")).toBeNull();
  input.remove();
  const stale = deferred(); around.mockReturnValueOnce(stale.promise);
  await render(page("a", 451, 500), { finding: true, findRequest: { seq: 10, serial: 2 } });
  await render(page("b", 1, 10));
  await act(async () => stale.resolve(page("a", 1, 50)));
  expect(rows().every((row) => row.textContent?.includes("b message"))).toBe(true);
});

it("groups only matching authors while retaining a visible internal-note label on every private message", async () => {
  const thread = page("a", 1, 4);
  thread.messages[2] = { ...thread.messages[2]!, authorType: "staff", authorUserId: "u", authorName: "Staff", visibility: "internal" };
  thread.messages[3] = { ...thread.messages[3]!, authorType: "staff", authorUserId: "u", authorName: "Staff", visibility: "internal" };
  await render(thread);
  expect(rows()[0]!.textContent).toContain("Customer");
  expect(rows()[1]!.textContent).not.toContain("Customer");
  expect(rows()[2]!.textContent).toContain(en.internalNote);
  expect(rows()[3]!.textContent).toContain(en.internalNote);
});

it("does not follow an incoming message from the bottom of a capped historical window", async () => {
  await render(page("a", 251, 300));
  for (let end = 250; end >= 100; end -= 50) {
    older.mockResolvedValueOnce(page("a", end - 49, end));
    await act(async () => button(en.loadOlder).click());
  }
  expect(sequences()).toHaveLength(200);
  expect(sequences().at(-1)).toBe(250);
  await scroll(3800);
  await render(page("a", 252, 301));
  expect(region().scrollTop).toBe(3800);
  expect(sequences().at(-1)).toBe(250);
  expect(button(en.backNewest)).toBeDefined();
});

it("retains live arrivals without jumping on find close and retries a failed single hit", async () => {
  const initial = page("a", 151, 200);
  await render(initial);
  around.mockResolvedValueOnce({ ...page("a", 1, 50, false), hasNewer: true });
  await render(initial, { finding: true, findRequest: { seq: 25, serial: 1 } });
  await scroll(160);
  await render(page("a", 153, 202), { finding: true });
  await render(page("a", 153, 202));
  expect(sequences().at(-1)).toBe(202);
  expect(region().scrollTop).toBe(160);
  around.mockRejectedValueOnce(new Error("offline"));
  const current = page("a", 153, 202);
  const request = { seq: 20, serial: 2 };
  await render(current, { finding: true, findRequest: request });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.findLoadFailed);
  around.mockResolvedValueOnce(page("a", 1, 50, false));
  await act(async () => { button(en.retry).focus(); button(en.retry).click(); });
  expect(document.activeElement).toBe(region());
  expect(around).toHaveBeenLastCalledWith("a", 20);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await scroll(120);
  await render(current);
  await render(page("a", 154, 203));
  expect(region().scrollTop).toBe(120);
});

it("offers a route back from an older find window and caps live query rows on return", async () => {
  const close = vi.fn();
  const current = page("a", 251, 300);
  await render(current);
  around.mockResolvedValueOnce({ ...page("a", 1, 50, false), hasNewer: true });
  await render(current, { finding: true, findRequest: { seq: 25, serial: 1 }, onCloseFind: close });
  await act(async () => button(en.backNewest).click());
  expect(close).toHaveBeenCalledOnce();
  await render(page("a", 1, 310, false));
  expect(sequences()).toHaveLength(200);
  expect(sequences().at(-1)).toBe(310);
});

it("explicit own-send follows its rendered row even when older history fills the mounted limit", async () => {
  await render(page("a", 251, 300));
  for (let end = 250; end >= 100; end -= 50) {
    older.mockResolvedValueOnce(page("a", end - 49, end));
    await act(async () => button(en.loadOlder).click());
  }
  await scroll(200);
  await render(page("a", 252, 301), { followRequest: { conversationId: "a", seq: 301 } });
  expect(sequences()).toHaveLength(200);
  expect(sequences().at(-1)).toBe(301);
  expect(region().scrollTop).toBe(region().scrollHeight);
});


it("does not prepend overlapping latest rows above an inspected newest match on close or refresh", async () => {
  const current = page("a", 51, 100);
  await render(current);
  around.mockResolvedValueOnce(page("a", 80, 100));
  await render(current, { finding: true, findRequest: { seq: 95, serial: 1 } });
  await scroll(180);
  await render(current);
  expect(sequences()[0]).toBe(80);
  expect(region().scrollTop).toBe(180);
  await render(page("a", 52, 101));
  expect(sequences()[0]).toBe(80);
  expect(sequences().at(-1)).toBe(101);
  expect(region().scrollTop).toBe(180);
  expect(button(en.loadOlder)).toBeDefined();
});
