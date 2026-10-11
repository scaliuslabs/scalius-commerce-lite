// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
const summary = vi.hoisted(() => ({ open: 8, unread: 0 }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: summary }), queryOptions: (options: unknown) => options }));
import { InboxNavBadge } from "./InboxNavBadge";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); setLocale("en"); });
afterEach(() => { act(() => root.unmount()); host.remove(); setLocale("en"); });
it("hides at zero unread even when conversations are open", async () => {
  summary.unread = 0;
  await act(async () => root.render(<InboxNavBadge />));
  expect(host.textContent).toBe("");
});
it.each([ ["en", "3", "99+", "123 unread"], ["bn", "৩", "৯৯+", "১২৩টি না-পড়া"] ] as const)("formats the incoming count and cap in %s while announcing the exact count", async (locale, count, cap, label) => {
  setLocale(locale);
  summary.unread = 3;
  await act(async () => root.render(<InboxNavBadge />));
  expect(host.textContent).toBe(count);
  summary.unread = 123;
  await act(async () => root.render(<InboxNavBadge />));
  expect(host.textContent).toBe(cap);
  expect(host.querySelector("span")?.getAttribute("aria-label")).toBe(label);
});
