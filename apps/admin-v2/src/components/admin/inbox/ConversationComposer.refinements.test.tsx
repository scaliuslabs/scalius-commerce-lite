// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { inboxMessages } from "~/i18n/inbox";
import { clearInboxDrafts, updateInboxDraft } from "~/lib/inbox-drafts";
const replies = vi.hoisted(() => ({ insert: (_value: string) => {} }));
vi.mock("@tanstack/react-router", () => ({ useRouteContext: () => "staff_1" }));
vi.mock("./inbox-api", () => ({ newRequestKey: () => "request_1", uploadConversationImage: vi.fn(), usePostMessage: () => ({ isPending: false, mutateAsync: vi.fn() }) }));
vi.mock("./ConversationProductsDialog", () => ({ ConversationProductsDialog: () => null }));
vi.mock("./SavedRepliesDialog", () => ({ SavedRepliesDialog: ({ onInsert }: { onInsert: (value: string) => void }) => { replies.insert = onInsert; return null; } }));
import { ConversationComposer } from "./ConversationComposer";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let resize: ResizeObserverCallback, disconnect: ReturnType<typeof vi.fn>;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const textarea = () => host.querySelector("textarea")!;
const flushFrames = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });
const write = async (text: string) => act(async () => { updateInboxDraft("staff_1", "conversation:thread_1", "public", (draft) => ({ ...draft, body: text })); });
const openAt = async (start: number, end: number) => {
  textarea().focus(); textarea().setSelectionRange(start, end);
  const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="${inboxMessages.en.composerTools}"]`)!;
  await act(async () => trigger.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, ctrlKey: false })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent === inboxMessages.en.savedReplies)!;
  await act(async () => item.click());
};
beforeEach(async () => {
  clearInboxDrafts(); frames.clear(); nextFrame = 0;
  disconnect = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect = disconnect; });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<PermissionProvider permissions={[]}><ConversationComposer conversationId="thread_1" /></PermissionProvider>));
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearInboxDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  ["history.", 8, 8, "Thanks", "history. Thanks", 15],
  ["helloWorld", 5, 5, "Thanks", "hello Thanks World", 12],
  ["hello world", 6, 6, "Thanks", "hello Thanks world", 12],
  ["hello old world", 6, 9, "Thanks", "hello Thanks world", 12],
  ["hello", 5, 5, " Thanks", "hello Thanks", 12],
])("inserts at the saved selection without joining words: %s", async (body, start, end, text, expected, caret) => {
  await write(body); await openAt(start, end);
  await act(async () => replies.insert(text)); await flushFrames();
  expect(textarea().value).toBe(expected);
  expect(textarea().selectionStart).toBe(caret); expect(textarea().selectionEnd).toBe(caret);
  expect(document.activeElement).toBe(textarea());
});

it("clamps an insertion position if the draft changes while the picker is open", async () => {
  await write("Long previous draft"); await openAt(19, 19); await write("Hi");
  await act(async () => replies.insert("Thanks")); await flushFrames();
  expect(textarea().value).toBe("Hi Thanks"); expect(textarea().selectionStart).toBe(9);
});

it("coalesces width refits, ignores height-only changes and cancels pending work on unmount", async () => {
  let height = 144;
  vi.spyOn(textarea(), "scrollHeight", "get").mockImplementation(() => height);
  await write("Unchanged long draft");
  expect(textarea().style.height).toBe("144px");
  const emit = (width: number) => resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
  height = 76; await act(async () => { emit(600); emit(620); });
  expect(frames.size).toBe(1); await flushFrames(); expect(textarea().style.height).toBe("76px");
  await act(async () => emit(620)); expect(frames.size).toBe(0);
  await act(async () => emit(300)); expect(frames.size).toBe(1);
  await act(async () => root.unmount()); expect(frames.size).toBe(0); expect(disconnect).toHaveBeenCalled();
});
