// @vitest-environment happy-dom
import { act, useEffect, type ReactNode, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StaffThread } from "~/lib/api-query-options/inbox";

const viewport = vi.hoisted(() => ({ width: 390, top: 80 }));
vi.mock("@tanstack/react-query", () => ({ queryOptions: (options: unknown) => options, useQuery: () => ({ data: { mineOpen: 0 } }) }));
vi.mock("./ContextRail", () => ({ ContextRail: () => <aside><a href="/admin/customers/customer_1/edit">View customer</a></aside> }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouteContext: () => "staff_1",
  Link: ({ to, children, params: _params, ...props }: { to: string; children: ReactNode; params?: unknown }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("./InboxList", () => ({ InboxList: () => null }));
vi.mock("./ConversationPane", () => ({
  NoConversationSelected: () => null,
  ConversationPane: ({ conversationId, onThread, active, onToggleDetails, detailsTrigger }: { conversationId: string; active: boolean; onThread: (thread: StaffThread) => void; onToggleDetails: () => void; detailsTrigger: RefObject<HTMLButtonElement | null> }) => {
    useEffect(() => onThread({ id: conversationId, customerId: "customer_1", customerName: "Customer", subjectType: "store", order: null } as StaffThread), [conversationId, onThread]);
    return <><h2 data-timeline-active={String(active)}>Conversation</h2><button ref={detailsTrigger} onClick={onToggleDetails}>Details</button></>;
  },
}));
// Subject workflows are tested separately; this check exercises their shared rail and real Sheet.
vi.mock("./subject-context", () => ({ SubjectContext: () => null }));

import { InboxWorkspace } from "./InboxWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const render = async (id = "thread_1") => {
  await act(async () => root.render(<InboxWorkspace selectedId={id} search={{}} />));
  await settle();
};
beforeEach(() => {
  viewport.width = 390; viewport.top = 80;
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: viewport.width, height: 600, top: viewport.top, bottom: viewport.top + 600, left: 0, right: viewport.width, x: 0, y: viewport.top, toJSON: () => ({}) }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens mobile details with its actions, closes with Escape and returns focus to Details", async () => {
  await render();
  expect(document.querySelector("aside")).toBeNull();
  const trigger = host.querySelector<HTMLButtonElement>("button")!;
  expect(trigger.textContent).toBe("Details");
  expect(host.querySelector("h2")?.getAttribute("data-timeline-active")).toBe("true");
  await act(async () => { trigger.focus(); trigger.click(); });
  await settle();
  expect(host.querySelector("h2")?.getAttribute("data-timeline-active")).toBe("false");
  const dialog = document.querySelector('[role="dialog"]')!;
  const action = dialog.querySelector<HTMLAnchorElement>("aside a")!;
  expect(action.textContent).toBe("View customer");
  expect(document.querySelectorAll("aside")).toHaveLength(1);
  await act(async () => {
    action.focus();
    action.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(host.querySelector("h2")?.getAttribute("data-timeline-active")).toBe("true");
});

it("switches to one desktop rail on resize and does not reopen the sheet on mobile", async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  viewport.width = 1280;
  await act(async () => window.dispatchEvent(new Event("resize")));
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelectorAll("aside")).toHaveLength(1);
  viewport.width = 390;
  await act(async () => window.dispatchEvent(new Event("resize")));
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("aside")).toBeNull();
});

it("opens customer details by default on desktop and remembers an explicit collapse", async () => {
  viewport.width = 1100;
  await render();
  expect(document.querySelector("aside")).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.querySelector("aside")).toBeNull();
  await render("thread_2");
  expect(document.querySelector("aside")).toBeNull();
});


it("leaves height to the shell even at a restored scroll offset and reserves only an overlaid keyboard", async () => {
  const visual = new EventTarget();
  Object.assign(visual, { height: 844, offsetTop: 0 });
  vi.stubGlobal("visualViewport", visual);
  vi.stubGlobal("innerHeight", 844);
  await render();
  const card = () => host.querySelector<HTMLElement>('[data-slot="card"]')!;
  const inset = () => card().parentElement!.style.getPropertyValue("--inbox-keyboard");
  expect(card().getAttribute("style")).toBeNull();
  expect(inset()).toBe("0px");
  vi.stubGlobal("innerHeight", 637); Object.assign(visual, { height: 637 });
  viewport.width = 1280; viewport.top = -240;
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(card().getAttribute("style")).toBeNull();
  expect(inset()).toBe("0px");
  vi.stubGlobal("innerHeight", 844); Object.assign(visual, { height: 500, offsetTop: 40 });
  viewport.width = 390; viewport.top = 80;
  await act(async () => visual.dispatchEvent(new Event("resize")));
  expect(inset()).toBe("304px");
  Object.assign(visual, { scale: 2 });
  await act(async () => visual.dispatchEvent(new Event("resize")));
  expect(inset()).toBe("0px");
  Object.assign(visual, { height: 844, offsetTop: 0, scale: 1 });
  await act(async () => visual.dispatchEvent(new Event("resize")));
  expect(inset()).toBe("0px");
});
