// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderReplyReachMessages } from "~/i18n/order-reply-reach";
import { ReplyReachNote, replyReach } from "./ReplyReachNote";

const mocks = vi.hoisted(() => ({ channels: {} as Record<string, string[]> | undefined, fail: false }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, hash, children, ...rest }: { to: string; hash?: string; children: React.ReactNode }) => (
    <a href={`${to}#${hash ?? ""}`} {...rest}>{children}</a>
  ),
}));
vi.mock("~/lib/api-query-options/settings-screens", () => ({
  customerRulesQuery: {
    queryKey: ["settings", "notification-channels"],
    queryFn: async () => {
      if (mocks.fail) throw new Error("forbidden");
      return { channels: mocks.channels };
    },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderReplyReachMessages.en;

const buyer: { customerName: string; customerEmail: string | null; customerPhone: string | null } = { customerName: "Rina", customerEmail: "rina@example.com", customerPhone: "+8801700000000" };

describe("reply reach", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.channels = undefined;
    mocks.fail = false;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function show(order: Partial<typeof buyer>) {
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReplyReachNote order={{ ...buyer, ...order }} />
      </QueryClientProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it("decides reachability from the channels and the contacts", () => {
    expect(replyReach(buyer, { email: true, sms: false })).toEqual({ reached: true, fix: null });
    expect(replyReach({ ...buyer, customerEmail: null }, { email: true, sms: true })).toEqual({ reached: true, fix: null });
    expect(replyReach({ ...buyer, customerEmail: null }, { email: true, sms: false })).toEqual({ reached: false, fix: "sms" });
    expect(replyReach({ ...buyer, customerPhone: null }, { email: false, sms: true })).toEqual({ reached: false, fix: "email" });
    expect(replyReach({ customerEmail: null, customerPhone: " " }, { email: true, sms: true })).toEqual({ reached: false, fix: null });
  });

  it("says nothing when the buyer will be notified", async () => {
    mocks.channels = { conversation_reply: ["email"] };
    await show({});
    expect(host.textContent).toBe("");
  });

  it("defaults to email when the merchant never changed the reply channels", async () => {
    mocks.channels = {};
    await show({});
    expect(host.textContent).toBe("");
    await show({ customerEmail: null });
    expect(host.textContent).toContain("Rina");
  });

  it("tells staff a phone-only guest won't be notified, with a link to the reply row", async () => {
    mocks.channels = { conversation_reply: ["email"] };
    await show({ customerEmail: null });
    expect(host.textContent).toContain(en["note"].replace("{name}", "Rina"));
    const link = host.querySelector("a")!;
    expect(link.textContent).toBe(en["linkSms"]);
    expect(link.getAttribute("href")).toBe("/admin/settings/notifications#customer-rule-conversation_reply");
  });

  it("offers email when only SMS is on and the buyer has an email", async () => {
    mocks.channels = { conversation_reply: ["sms"] };
    await show({ customerPhone: null });
    expect(host.querySelector("a")!.textContent).toBe(en["linkEmail"]);
  });

  it("falls back to the plain link when no contact matches", async () => {
    mocks.channels = { conversation_reply: ["email"] };
    await show({ customerEmail: null, customerPhone: null, customerName: "" });
    expect(host.textContent).toContain(en["fallbackName"]);
    expect(host.querySelector("a")!.textContent).toBe(en["link"]);
  });

  it("stays quiet when the settings can't be read", async () => {
    mocks.fail = true;
    await show({ customerEmail: null });
    expect(host.textContent).toBe("");
  });
});
