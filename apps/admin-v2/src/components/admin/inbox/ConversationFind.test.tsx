// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inboxMessages } from "~/i18n/inbox";
const search = vi.hoisted(() => vi.fn());
vi.mock("@scalius/api-client/sdk", () => ({ postApiV1AdminConversationsByIdSearch: search }));
import { ConversationFind } from "./ConversationFind";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = inboxMessages.en;
const page = (seqs: number[], nextCursor: number | null = null) => ({ data: { success: true, data: { items: seqs.map((seq) => ({ seq })), nextCursor, scanExhausted: nextCursor === null, scanned: 50 } }, response: new Response() });
let host: HTMLDivElement, root: Root, client: QueryClient;
const select = vi.fn(), close = vi.fn();
const input = () => host.querySelector("input")!;
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const settle = async (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const render = async (id = "thread_a") => act(async () => root.render(<QueryClientProvider client={client}><ConversationFind conversationId={id} onSelect={select} onClose={close} /></QueryClientProvider>));
const enter = async (text: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text); input().dispatchEvent(new Event("input", { bubbles: true })); });
  await settle(310); await settle();
};
const key = async (key: string, options: KeyboardEventInit = {}) => { await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options }))); await settle(); };
beforeEach(() => {
  search.mockReset(); select.mockReset(); close.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); });

it("selects once without stealing input focus and navigates retained pages in both directions", async () => {
  search.mockResolvedValueOnce(page([25, 20], 20)).mockResolvedValueOnce(page([10]));
  await render(); await enter("warranty");
  expect(select.mock.calls).toEqual([[25]]); expect(document.activeElement).toBe(input());
  expect(host.querySelector('[role="status"]')?.textContent).toBe("1 of 2+");
  expect(search).toHaveBeenCalledTimes(1);
  await key("Enter", { isComposing: true }); expect(select).toHaveBeenCalledTimes(1);
  await key("Enter"); expect(select).toHaveBeenLastCalledWith(20);
  await key("Enter"); expect(select).toHaveBeenLastCalledWith(10);
  expect(search).toHaveBeenLastCalledWith({ path: { id: "thread_a" }, body: { q: "warranty", cursor: 20 } });
  expect(host.querySelector('[role="status"]')?.textContent).toBe("3 of 3");
  expect(button(en.olderMatch).disabled).toBe(true);
  await key("Enter", { shiftKey: true }); expect(select).toHaveBeenLastCalledWith(20);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("2 of 3");
  const count = select.mock.calls.length;
  await act(async () => client.setQueryData(["conversations", "find", "thread_a", "warranty"], { pages: [page([25, 20], 20).data.data, page([10]).data.data], pageParams: [undefined, 20] }));
  await settle(); expect(select).toHaveBeenCalledTimes(count);
  await key("Escape"); expect(close).toHaveBeenCalledOnce();
});

it("continues empty bounded scan pages explicitly without announcing no matches prematurely", async () => {
  search.mockResolvedValueOnce(page([], 80)).mockResolvedValueOnce(page([70]));
  await render(); await enter("needle");
  expect(host.querySelector('[role="status"]')?.textContent).toBe(en.searchContinue);
  expect(select).not.toHaveBeenCalled(); expect(search).toHaveBeenCalledTimes(1);
  await key("Enter");
  expect(select.mock.calls).toEqual([[70]]);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("1 of 1");
  search.mockResolvedValueOnce(page([])); await enter("absent");
  expect(host.querySelector('[role="status"]')?.textContent).toBe(en.noFindResults);
  expect(button(en.olderMatch).disabled).toBe(true);
});

it("ignores a pending older selection after the search changes", async () => {
  let resolve!: (value: ReturnType<typeof page>) => void;
  search.mockResolvedValueOnce(page([90], 80)).mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValueOnce(page([60]));
  await render(); await enter("first"); await key("Enter");
  await enter("second"); expect(select).toHaveBeenLastCalledWith(60);
  await act(async () => resolve(page([70]))); await settle();
  expect(select.mock.calls).toEqual([[90], [60]]);
});
