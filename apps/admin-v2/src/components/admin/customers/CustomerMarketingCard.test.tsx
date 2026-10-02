// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { customersMessages } from "~/i18n/customers";

const sdk = vi.hoisted(() => ({
  getApiV1AdminCustomersByIdMarketing: vi.fn(),
  putApiV1AdminCustomersByIdMarketing: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CustomerMarketingCard } from "./CustomerMarketingCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof customersMessages.en, vars?: Record<string, string | number>) => translate(customersMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });

const consent = (channel: string, status: string, extra: Record<string, unknown> = {}) => ({
  channel,
  status,
  state: status === "not_subscribed" ? null : status,
  contact: channel === "email" ? "rahim@example.com" : "+8801712345678",
  consentContact: null,
  source: null,
  consentTextVersion: null,
  subscribedAt: null,
  unsubscribedAt: null,
  requestedAt: null,
  updatedAt: null,
  ...extra,
});

const MARKETING = {
  consents: [
    consent("email", "subscribed", { source: "checkout", subscribedAt: "2026-10-02T04:00:00.000Z" }),
    consent("sms", "not_subscribed"),
    consent("whatsapp", "unsubscribed", { source: "link", unsubscribedAt: "2026-09-01T04:00:00.000Z" }),
  ],
  events: [{
    id: "evt_1", channel: "email", previousState: null, state: "subscribed", source: "checkout", actor: "buyer", actorName: null,
    note: null, contact: "rahim@example.com", consentTextVersion: null, consentText: null, createdAt: "2026-10-02T04:00:00.000Z",
  }],
  tags: [],
};

const buttonNamed = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);

async function typeInto(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("customer marketing card", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminCustomersByIdMarketing.mockImplementation(() => ok(MARKETING));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(canEdit = true) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CustomerMarketingCard customerId="cus_1" canEdit={canEdit} />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain(t("status.subscribed")));
  }

  it("shows each channel's status in words with where and when, and the consent log", async () => {
    await render();
    const badges = [...container.querySelectorAll("li span")].map((element) => element.textContent);
    expect(badges).toEqual(expect.arrayContaining([t("status.subscribed"), t("status.not_subscribed"), t("status.unsubscribed")]));
    expect(container.textContent).toContain(t("source.checkout"));
    expect(container.textContent).toContain(t("source.link"));
    expect(container.textContent).toContain(t("consentHistory"));
    expect(container.textContent).toContain(t("eventByBuyer"));
  });

  it("asks how the customer agreed before subscribing them, then records it", async () => {
    await render();
    await act(async () => buttonNamed(t("editMarketing"))!.click());
    // The first channel is subscribed already, so Unsubscribe is offered.
    expect(document.getElementById("consent-change-unsubscribed")?.getAttribute("aria-checked")).toBe("true");

    await act(async () => document.getElementById("consent-channel-sms")!.click());
    expect(document.getElementById("consent-change-subscribed")?.getAttribute("aria-checked")).toBe("true");

    await act(async () => buttonNamed("Save")!.click());
    expect(document.body.textContent).toContain(t("consentNoteRequired"));
    expect(sdk.putApiV1AdminCustomersByIdMarketing).not.toHaveBeenCalled();

    sdk.putApiV1AdminCustomersByIdMarketing.mockImplementation(() => ok({
      ...MARKETING,
      consents: [MARKETING.consents[0], consent("sms", "subscribed", { source: "admin" }), MARKETING.consents[2]],
    }));
    await typeInto(document.getElementById("consent-note") as HTMLTextAreaElement, "Asked by phone");
    await act(async () => buttonNamed("Save")!.click());
    expect(sdk.putApiV1AdminCustomersByIdMarketing).toHaveBeenCalledWith({
      path: { id: "cus_1" },
      body: { channel: "sms", state: "subscribed", note: "Asked by phone" },
    });
  });

  it("offers no edit without the permission", async () => {
    await render(false);
    expect(buttonNamed(t("editMarketing"))).toBeUndefined();
  });
});
