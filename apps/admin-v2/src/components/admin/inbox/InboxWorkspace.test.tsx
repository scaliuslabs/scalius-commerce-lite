// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StaffThread } from "~/lib/api-query-options/inbox";

const viewport = vi.hoisted(() => ({ wide: false }));
vi.mock("~/hooks/use-media-query", () => ({ useMediaQuery: () => viewport.wide }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouteContext: () => "staff_1",
  Link: ({ to, children, params: _params, ...props }: { to: string; children: ReactNode; params?: unknown }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("./InboxList", () => ({ InboxList: () => null }));
vi.mock("./ConversationPane", () => ({
  NoConversationSelected: () => null,
  ConversationPane: ({ conversationId, onThread }: { conversationId: string; onThread: (thread: StaffThread) => void }) => {
    useEffect(() => onThread({ id: conversationId, customerId: "customer_1", customerName: "Customer", subjectType: "store", order: null } as StaffThread), [conversationId, onThread]);
    return <h2>Conversation</h2>;
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
  viewport.wide = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("opens mobile details with its actions, closes with Escape and returns focus to Details", async () => {
  await render();
  expect(document.querySelector("aside")).toBeNull();
  const trigger = host.querySelector<HTMLButtonElement>("button")!;
  expect(trigger.textContent).toBe("Details");
  await act(async () => { trigger.focus(); trigger.click(); });
  await settle();
  const dialog = document.querySelector('[role="dialog"]')!;
  const action = dialog.querySelector<HTMLAnchorElement>("aside a")!;
  expect(action.textContent).toBe("View customer");
  expect(document.querySelectorAll("aside")).toHaveLength(1);
  await act(async () => {
    action.focus();
    action.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("switches to one desktop rail on resize and does not reopen the sheet on mobile", async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  viewport.wide = true;
  await render();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelectorAll("aside")).toHaveLength(1);
  viewport.wide = false;
  await render();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("aside")).toBeNull();
});
