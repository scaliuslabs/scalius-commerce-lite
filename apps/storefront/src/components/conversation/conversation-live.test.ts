// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendConversationItems, bindConversationLive, notifyConversationSent, stopConversationLive } from "./conversation-live";
vi.mock("@/lib/presence-url", () => ({ pagePath: (path: string) => path }));
const item = (seq: number, from = "store") => ({ id: `msg_${seq}`, seq, html: `<li data-seq="${seq}" data-message-id="msg_${seq}" data-from="${from}">Message ${seq}</li>` });
const answer = (items = [item(2)], extra = {}) => Response.json({ success: true, data: { conversationId: "cnv_12345678", items, hasNewer: false, ...extra } });
const pollCalls = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method !== "POST");
let list: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init) => Promise.resolve(init?.method === "POST" ? new Response(null, { status: 204 }) : answer([]))));
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `<section data-conversation-panel><ol data-live-src="/api/conversations/cnv_12345678/messages" data-read-src="/api/conversations/cnv_12345678/read" data-read-seq="1" data-conversation-id="cnv_12345678">${item(1).html}</ol><p data-conversation-live-status></p><button hidden data-conversation-new>New messages</button><a hidden data-conversation-reload>Reload</a><textarea></textarea></section>`;
  list = document.querySelector("ol")!;
});
afterEach(() => { stopConversationLive(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe("immutable message merge", () => {
  it("preserves earlier rows and images, deduplicates overlaps and rejects mismatched HTML", () => {
    const first = list.firstElementChild;
    appendConversationItems(list, [item(2), item(1), { ...item(3), html: item(4).html }, item(2)], 1);
    expect(list.firstElementChild).toBe(first);
    expect([...list.children].map((node) => node.getAttribute("data-seq"))).toEqual(["1", "2"]);
  });
  it("accepts sequence holes left by private notes", () => {
    appendConversationItems(list, [item(6), item(3)], 1);
    expect([...list.children].map((node) => node.getAttribute("data-seq"))).toEqual(["1", "3", "6"]);
  });
});

describe("buyer live lifecycle", () => {
  it("performs no work while prerendered and works without modern AbortSignal statics", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const any = vi.spyOn(AbortSignal, "any").mockImplementation(() => { throw new Error("not supported"); });
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { throw new Error("not supported"); });
    bindConversationLive(); await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1);
    expect(pollCalls()).toHaveLength(1);
    expect(any).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled();
  });
  it("resumes after inactivity when the buyer starts typing again", async () => {
    bindConversationLive(); await vi.advanceTimersByTimeAsync(31 * 60_000);
    const before = pollCalls().length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollCalls()).toHaveLength(before);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(pollCalls()).toHaveLength(before + 1);
  });
  it("stops repeating an invalid read acknowledgment on scroll", async () => {
    vi.mocked(fetch).mockImplementation((_url, init) => Promise.resolve(init?.method === "POST" ? new Response(null, { status: 404 }) : answer()));
    bindConversationLive(); await vi.advanceTimersByTimeAsync(1);
    vi.spyOn(list.lastElementChild!, "getBoundingClientRect").mockReturnValue({ top: 30, bottom: 90, height: 60 } as DOMRect);
    window.dispatchEvent(new Event("scroll")); await vi.advanceTimersByTimeAsync(800);
    window.dispatchEvent(new Event("scroll")); await vi.advanceTimersByTimeAsync(800);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("loads guest history in place without dropping current rows or the composer draft", async () => {
    list.innerHTML = item(8).html;
    const link = document.createElement("a");
    link.setAttribute("data-conversation-earlier", ""); link.dataset.before = "8"; link.href = "/order-success?orderId=order_1&conversationBefore=8"; link.dataset.beforeParam = "conversationBefore";
    list.before(link);
    const draft = document.querySelector("textarea")!; draft.value = "Still writing";
    vi.mocked(fetch).mockImplementation((url, init) => Promise.resolve(String(url).includes("beforeSeq") ? answer([item(6), item(7)], { hasOlder: false }) : init?.method === "POST" ? new Response(null, { status: 204 }) : answer([])));
    bindConversationLive(); await vi.advanceTimersByTimeAsync(1);
    const latest = list.lastElementChild;
    link.click(); await vi.advanceTimersByTimeAsync(1);
    expect([...list.children].map((row) => row.getAttribute("data-seq"))).toEqual(["6", "7", "8"]);
    expect(list.lastElementChild).toBe(latest); expect(draft.value).toBe("Still writing"); expect(link.hidden).toBe(true);
  });
  it("receives a reply without reloading and does not mark an offscreen message read", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(answer());
    bindConversationLive();
    await vi.advanceTimersByTimeAsync(1);
    expect(list.textContent).toContain("Message 2");
    expect(pollCalls()[0]![0].toString()).toContain("afterSeq=1");
    await vi.advanceTimersByTimeAsync(800);
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("[data-conversation-new]")!.hidden).toBe(false);
  });
  it("stops while hidden and ignores an in-flight answer after suspension", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    bindConversationLive(); await vi.advanceTimersByTimeAsync(1);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    resolve(answer()); await vi.advanceTimersByTimeAsync(60_000);
    expect(list.children).toHaveLength(1);
    expect(pollCalls()).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1);
    expect(pollCalls()).toHaveLength(2);
  });
  it("honors retry-after and stops on revoked access", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "45" } })).mockResolvedValueOnce(new Response(null, { status: 404 }));
    bindConversationLive(); await vi.advanceTimersByTimeAsync(10_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(34_000);
    expect(pollCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pollCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(pollCalls()).toHaveLength(2);
    expect(document.querySelector("[data-conversation-live-status]")!.textContent).toContain("no longer available");
  });
  it("bounds catch-up work at four pages instead of skipping or looping", async () => {
    vi.mocked(fetch).mockImplementation((url) => Promise.resolve(answer([item(Number(new URL(String(url)).searchParams.get("afterSeq")) + 1)], { hasNewer: true })));
    bindConversationLive(); await vi.advanceTimersByTimeAsync(100);
    expect(pollCalls()).toHaveLength(4);
    expect(list.children).toHaveLength(5);
    expect(document.querySelector("[data-conversation-live-status]")!.textContent).toContain("Reload");
  });
  it("does not merge a latest-page post across a missing history gap", () => {
    bindConversationLive();
    notifyConversationSent(list, { conversationId: "cnv_12345678", items: [item(60)], hasOlder: true });
    expect(list.children).toHaveLength(1);
    notifyConversationSent(list, { conversationId: "cnv_12345678", items: [item(1), item(2)], hasOlder: true });
    expect(list.children).toHaveLength(2);
  });
  it("cleans up and clears rendered private messages on an account change", async () => {
    bindConversationLive(); await vi.advanceTimersByTimeAsync(1);
    window.dispatchEvent(new Event("customer-logout"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list.children).toHaveLength(0);
    expect(pollCalls()).toHaveLength(1);
  });
  it("marks only visible rendered rows after the display debounce", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(answer());
    bindConversationLive(); await vi.advanceTimersByTimeAsync(1);
    const row = list.lastElementChild!;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: 30, bottom: 90, height: 60 } as DOMRect);
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(800);
    const reads = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(reads).toHaveLength(1);
    expect(JSON.parse(String(reads[0]![1]!.body))).toEqual({ seq: 2 });
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(800);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});

describe("bounded account workspace", () => {
  function pane() {
    const root = document.createElement("div");
    root.setAttribute("data-conversation-scroller", ""); root.style.overflowY = "auto";
    list.before(root); root.append(list);
    Object.defineProperties(root, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 300, configurable: true } });
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 400, height: 300 } as DOMRect);
    return root;
  }
  it("does not acknowledge rows hidden behind the tray until the pane reveals them", async () => {
    const root = pane();
    list.innerHTML += item(2).html;
    const row = list.lastElementChild!;
    const bounds = vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: 450, bottom: 510, height: 60 } as DOMRect);
    bindConversationLive(); await vi.advanceTimersByTimeAsync(800);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    bounds.mockReturnValue({ top: 180, bottom: 240, height: 60 } as DOMRect);
    root.dispatchEvent(new Event("scroll")); await vi.advanceTimersByTimeAsync(800);
    expect(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body).toBe('{"seq":2}');
  });
  it("preserves history position on arrival and follows the pane after an explicit send", async () => {
    const root = pane();
    bindConversationLive(); root.scrollTop = 100; root.dispatchEvent(new Event("scroll"));
    vi.mocked(fetch).mockResolvedValueOnce(answer());
    await vi.advanceTimersByTimeAsync(1);
    expect(root.scrollTop).toBe(100);
    expect(document.querySelector<HTMLButtonElement>("[data-conversation-new]")!.hidden).toBe(false);
    notifyConversationSent(list, { conversationId: "cnv_12345678", items: [item(2), item(3, "buyer")], hasOlder: true });
    expect(root.scrollTop).toBe(1000);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });
  it("keeps document-flow behavior when the short-height pane is not scrollable", async () => {
    const root = pane(); root.style.overflowY = "visible";
    list.innerHTML += item(2).html;
    vi.spyOn(list.lastElementChild!, "getBoundingClientRect").mockReturnValue({ top: 450, bottom: 510, height: 60 } as DOMRect);
    bindConversationLive(); await vi.advanceTimersByTimeAsync(800);
    expect(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body).toBe('{"seq":2}');
    expect(root.scrollTop).toBe(0);
  });
});

it("updates workspace heading status after it moves outside the message panel", async () => {
  const shell = document.createElement("section"); shell.setAttribute("data-account-workspace", "true");
  const status = document.createElement("span"); status.setAttribute("data-conversation-thread-status", ""); status.textContent = "Waiting for the store";
  const panel = document.querySelector<HTMLElement>("[data-conversation-panel]")!;
  panel.before(shell); shell.append(status, panel);
  vi.mocked(fetch).mockResolvedValueOnce(answer([], { status: "closed" }));
  bindConversationLive(); await vi.advanceTimersByTimeAsync(1);
  expect(status.textContent).toBe("Closed");
});
