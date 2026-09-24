// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { Order } from "./types";
import { OrderNotificationsCard } from "./OrderNotificationsCard";

vi.mock("~/lib/order-detail-prefetch", () => ({ ORDER_DETAIL_PREFETCH_STALE_MS: 30_000 }));
vi.mock("~/hooks/use-order-action-permissions", () => ({ useOrderActionPermissions: () => ({ canRetryOrderNotifications: true }) }));
vi.mock("~/lib/api-query-options/orders", () => ({
  orderNotificationsQueryOptions: (id: string) => ({ queryKey: ["notifications", id], queryFn: () => new Promise(() => undefined) }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  useRetryOrderNotification: () => ({ mutate: vi.fn(), isPending: false }),
  useResendOrderNotification: () => ({ mutate: vi.fn(), isPending: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;

const outbox = (overrides: Record<string, unknown>) => ({
  id: "out_1", notificationType: "order_confirmed", status: "sent", lastError: null,
  queuedAt: 1_783_000_000, sentAt: 1_783_000_010, createdAt: 1_783_000_000, receipts: [], ...overrides,
});
const emailSent = {
  id: "rcpt_1", channel: "email", status: "accepted", recipientMasked: "r***@example.com", lastError: null, providerStatus: null,
};

describe("OrderNotificationsCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    document.body.innerHTML = "";
  });

  async function render(notifications: ReturnType<typeof outbox>[]) {
    client.setQueryData(["notifications", "ord_1"], { notifications });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <OrderNotificationsCard order={{ id: "ord_1" } as Order} />
      </QueryClientProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it("reads Not sent, with the reason and no Send again, when nothing was delivered", async () => {
    await render([outbox({ notificationType: "support_request_submitted" })]);
    expect(host.textContent).toContain(en["messages.status.skipped"]);
    expect(host.textContent).toContain(en["messages.issue.noChannel"]);
    expect(host.textContent).not.toContain(en["messages.status.sent"]);
    expect(host.textContent).not.toContain(en["messages.sendAgain"]);
  });

  it("says a message turned off in Notifications wasn't sent, and why, keeping Send again", async () => {
    await render([outbox({
      receipts: [{ ...emailSent, status: "skipped", lastError: "notification_turned_off" }],
    })]);
    const row = host.querySelector("li")!;
    expect(row.textContent).toContain(`Email · r***@example.com · ${en["messages.status.skipped"]} · ${en["messages.issue.turnedOff"]}`);
    expect(row.textContent).not.toContain(en["messages.status.partial"]);
    expect(row.textContent).toContain(en["messages.sendAgain"]);
  });

  it("says Sent once when one channel carried the message", async () => {
    await render([outbox({ receipts: [emailSent] })]);
    const row = host.querySelector("li")!;
    expect(row.textContent).toContain("Email · r***@example.com");
    expect(row.textContent?.split(en["messages.status.sent"]).length).toBe(2);
  });
});
