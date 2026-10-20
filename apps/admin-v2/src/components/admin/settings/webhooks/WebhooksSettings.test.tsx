// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The webhook endpoints are mocked by name; the generated SDK may not have them yet.
const sdk = vi.hoisted(() => ({
  getApiV1AdminWebhooks: vi.fn(),
  postApiV1AdminWebhooks: vi.fn(),
  getApiV1AdminWebhooksById: vi.fn(),
  patchApiV1AdminWebhooksById: vi.fn(),
  deleteApiV1AdminWebhooksById: vi.fn(),
  postApiV1AdminWebhooksByIdRotateSecret: vi.fn(),
  postApiV1AdminWebhooksByIdTest: vi.fn(),
  getApiV1AdminWebhooksByIdDeliveries: vi.fn(),
  postApiV1AdminWebhooksByIdDeliveriesByDeliveryIdRetry: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: toasts }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { setLocale } from "~/i18n";
import { WebhooksSettings } from "./WebhooksSettings";
import { normalizeTopics } from "./WebhookTopicPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = "whsec_0123456789abcdefghijklmnopqrstuvwxyzABCD";
const ROTATED = "whsec_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxw";
const MANAGER = ["webhooks.view", "webhooks.manage"];

const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const refused = (status: number, code: string, message: string) =>
  Promise.resolve({ error: { success: false, error: { code, message } }, response: { status } });

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "whs_1",
    url: "https://hooks.example.com/scalius",
    topics: ["order.*"],
    apiVersion: "2026-10",
    description: null,
    status: "active",
    disabledReason: null,
    disabledAt: null,
    failureStreak: 0,
    failingSince: null,
    lastSuccessAt: "2026-10-01T08:00:00.000Z",
    lastFailureAt: null,
    secretHint: "ABCD",
    version: 1,
    createdAt: "2026-09-30T08:00:00.000Z",
    updatedAt: "2026-09-30T08:00:00.000Z",
    ...overrides,
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "whd_1",
    subscriptionId: "whs_1",
    eventId: "evt_1",
    kind: "event",
    topic: "order.created",
    resourceType: "order",
    resourceId: "ord_1",
    status: "succeeded",
    attempts: 1,
    maxAttempts: 8,
    responseStatus: 200,
    durationMs: 132,
    responseExcerpt: null,
    error: null,
    nextAttemptAt: null,
    lastAttemptAt: "2026-10-01T08:00:00.000Z",
    deliveredAt: "2026-10-01T08:00:00.000Z",
    createdAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function listWith(...subscriptions: object[]) {
  sdk.getApiV1AdminWebhooks.mockImplementation(() =>
    ok({ subscriptions, maxSubscriptions: 20, apiVersion: "2026-10", topicFilters: [] }),
  );
}

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function render(permissions: string[], isSuperAdmin = false) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
          <WebhooksSettings />
        </PermissionProvider>
      </QueryClientProvider>,
    ),
  );
  await flush();
}

const text = () => document.body.textContent ?? "";
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;

function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const match = [...within.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!match) throw new Error(`No button "${label}"`);
  return match;
}

function buttons(label: string, within: ParentNode = document): HTMLButtonElement[] {
  return [...within.querySelectorAll("button")].filter((element) => element.textContent?.trim() === label);
}

/** The checkbox of a labelled choice in the event picker. */
function checkbox(label: string): HTMLButtonElement {
  const match = [...dialog().querySelectorAll("label")].find((element) => element.textContent?.trim() === label);
  const box = match?.querySelector<HTMLButtonElement>('[role="checkbox"]');
  if (!box) throw new Error(`No checkbox "${label}"`);
  return box;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Opens a row's actions menu and returns its item labels. */
async function openMenu(host: string): Promise<string[]> {
  const trigger = document.querySelector<HTMLButtonElement>(`button[aria-haspopup="menu"][aria-label*="${host}"]`);
  if (!trigger) throw new Error(`No menu for ${host}`);
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  await flush();
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? "");
}

async function chooseMenuItem(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.trim() === label);
  if (!item) throw new Error(`No menu item "${label}"`);
  await click(item);
}

function stored(storage: Storage): string {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)!;
    return `${key}=${storage.getItem(key)}`;
  }).join("\n");
}

function expectSecretKeptOut(secret: string) {
  expect(stored(localStorage)).not.toContain(secret);
  expect(stored(sessionStorage)).not.toContain(secret);
  expect(window.location.href).not.toContain(secret);
  expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(secret);
  expect(JSON.stringify(queryClient.getMutationCache().getAll().map((mutation) => mutation.state.data))).not.toContain(secret);
  expect(JSON.stringify([toasts.success.mock.calls, toasts.error.mock.calls])).not.toContain(secret);
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  listWith(subscription());
});

afterEach(() => {
  setLocale("en");
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("topic filters", () => {
  it("drops topics a chosen group already covers and keeps catalog order", () => {
    expect(normalizeTopics(["product.created", "order.paid", "order.*"])).toEqual(["order.*", "product.created"]);
    expect(normalizeTopics(["order.paid", "*", "customer.updated"])).toEqual(["*"]);
    expect(normalizeTopics(new Set(["customer.updated", "order.created", "order.created"]))).toEqual(["order.created", "customer.updated"]);
  });

  it("sends only catalog filters, the only ones the API accepts", () => {
    expect(normalizeTopics(["order.created", "future.topic"])).toEqual(["order.created"]);
  });
});

describe("Settings › Webhooks", () => {
  it("explains webhooks in one sentence and offers one Create webhook button when there are none", async () => {
    listWith();
    await render(MANAGER);
    await vi.waitFor(() => expect(text()).toContain("No webhooks yet"));
    expect(text()).toContain("Send store events, like a new order, to your own app or service as they happen.");
    expect(buttons("Create webhook")).toHaveLength(1);
  });

  it("lists each endpoint with its events and health, and warns when one was turned off for failing", async () => {
    listWith(
      subscription({
        topics: ["order.created", "order.paid", "product.updated", "customer.created", "return.updated"],
        failureStreak: 7,
      }),
      subscription({
        id: "whs_2",
        url: "https://erp.example.org/in",
        status: "disabled",
        disabledReason: "failing",
        disabledAt: "2026-10-01T09:00:00.000Z",
        failureStreak: 20,
        lastSuccessAt: null,
        version: 4,
      }),
    );
    await render(MANAGER);
    await vi.waitFor(() => expect(text()).toContain("https://erp.example.org/in"));

    const banner = document.querySelector('[role="status"]')!;
    expect(banner.textContent).toContain("1 webhook was turned off");
    expect(banner.textContent).toContain("send a test, then enable them again");
    expect(text()).toContain("https://hooks.example.com/scalius");
    expect(text()).toContain("Active");
    expect(text()).toContain("Disabled — failing");
    expect(text()).toContain("Order created");
    expect(text()).toContain("+2");
    expect(text()).toContain("Last 7 deliveries failed");
    expect(text()).toContain("Nothing delivered yet");
    expect(text()).toContain("2 of 20 webhooks · API version 2026-10");
  });

  it("creates a webhook with normalized events and shows its signing secret once", async () => {
    listWith();
    sdk.postApiV1AdminWebhooks.mockImplementation(() => ok({ subscription: subscription(), secret: SECRET }));
    await render(MANAGER);
    await vi.waitFor(() => expect(text()).toContain("No webhooks yet"));

    await click(button("Create webhook"));
    await type(document.getElementById("webhook-url") as HTMLInputElement, " https://hooks.example.com/scalius ");
    await click(checkbox("Order paid"));
    await click(checkbox("All order events"));
    // The group covers its topics: they show ticked and locked.
    expect(checkbox("Order paid").getAttribute("data-state")).toBe("checked");
    expect(checkbox("Order paid").disabled).toBe(true);
    await click(checkbox("Product created"));
    // Buyer contact data starts off; this endpoint takes phone numbers only.
    expect(checkbox("Phone numbers").getAttribute("data-state")).toBe("unchecked");
    await click(checkbox("Phone numbers"));
    await click(button("Create webhook", dialog()));

    expect(sdk.postApiV1AdminWebhooks).toHaveBeenCalledOnce();
    expect(sdk.postApiV1AdminWebhooks.mock.calls[0]![0]).toEqual({
      body: { url: "https://hooks.example.com/scalius", topics: ["order.*", "product.created"], description: null, customerData: ["phone"] },
    });
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Signing secret"]')?.value).toBe(SECRET),
    );
    expect(text()).toContain("Copy this secret now. You won't see it again.");
    expect(text()).toContain("Scalius-Signature: t=…,v1=…");
    expect(text()).toContain("Scalius-Event-Id");
    expect(toasts.success).toHaveBeenCalledWith("Webhook created");
    expectSecretKeptOut(SECRET);

    await click(button("I've saved it"));
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("checks the URL and events before sending anything, in plain words", async () => {
    listWith();
    await render(MANAGER);
    await vi.waitFor(() => expect(text()).toContain("No webhooks yet"));

    await click(button("Create webhook"));
    await type(document.getElementById("webhook-url") as HTMLInputElement, "http://localhost:8787/hook");
    await click(button("Create webhook", dialog()));

    expect(sdk.postApiV1AdminWebhooks).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("The URL must start with https://.");
    expect(dialog().textContent).toContain("Choose at least one event.");

    await type(document.getElementById("webhook-url") as HTMLInputElement, "https://10.0.0.5/hook");
    await click(button("Create webhook", dialog()));
    expect(dialog().textContent).toContain("Use a public internet address, not a private, local or reserved one.");
    expect(sdk.postApiV1AdminWebhooks).not.toHaveBeenCalled();
  });

  it("refuses a stale edit and saves it on the newer version after reloading", async () => {
    sdk.patchApiV1AdminWebhooksById
      .mockImplementationOnce(() => refused(409, "webhook_version_conflict", "This webhook changed."))
      .mockImplementation(({ body }: { body: Record<string, unknown> }) =>
        ok({ subscription: subscription({ ...body, version: 3 }) }));
    sdk.getApiV1AdminWebhooksById.mockImplementation(() =>
      ok({ subscription: subscription({ description: "Warehouse", version: 2 }) }));
    await render(MANAGER, true);
    await vi.waitFor(() => expect(text()).toContain("https://hooks.example.com/scalius"));

    await openMenu("hooks.example.com");
    await chooseMenuItem("Edit");
    await type(document.getElementById("webhook-url") as HTMLInputElement, "https://hooks.example.com/v2");
    await click(button("Save", dialog()));

    expect(sdk.patchApiV1AdminWebhooksById.mock.calls[0]![0]).toEqual({
      path: { id: "whs_1" },
      body: { url: "https://hooks.example.com/v2", expectedVersion: 1 },
    });
    expect(dialog().textContent).toContain("Someone else changed this webhook since you opened it.");

    await click(button("Reload and keep my edits", dialog()));
    await vi.waitFor(() => expect(sdk.getApiV1AdminWebhooksById).toHaveBeenCalledWith({ path: { id: "whs_1" } }));
    // Their description arrives; the URL edit stays.
    await vi.waitFor(() =>
      expect((document.getElementById("webhook-description") as HTMLInputElement).value).toBe("Warehouse"),
    );
    expect((document.getElementById("webhook-url") as HTMLInputElement).value).toBe("https://hooks.example.com/v2");

    await click(button("Save", dialog()));
    expect(sdk.patchApiV1AdminWebhooksById.mock.calls[1]![0]).toEqual({
      path: { id: "whs_1" },
      body: { url: "https://hooks.example.com/v2", expectedVersion: 2 },
    });
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Webhook saved"));
  });

  it("rotates the secret only after confirming, then shows the new one once", async () => {
    sdk.postApiV1AdminWebhooksByIdRotateSecret.mockImplementation(() =>
      ok({ subscription: subscription({ version: 2, secretHint: "wxyz" }), secret: ROTATED }));
    await render(MANAGER, true);
    await vi.waitFor(() => expect(text()).toContain("https://hooks.example.com/scalius"));

    await openMenu("hooks.example.com");
    await chooseMenuItem("Rotate secret");
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm.textContent).toContain("Rotate the secret for hooks.example.com?");
    expect(confirm.textContent).toContain("The current secret stops working right away.");
    expect(sdk.postApiV1AdminWebhooksByIdRotateSecret).not.toHaveBeenCalled();
    await click(button("Rotate secret", confirm));

    expect(sdk.postApiV1AdminWebhooksByIdRotateSecret).toHaveBeenCalledWith({ path: { id: "whs_1" } });
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Signing secret"]')?.value).toBe(ROTATED),
    );
    expect(text()).toContain("Copy the new signing secret");
    expectSecretKeptOut(ROTATED);
    await click(button("I've saved it"));
    expect(document.body.innerHTML).not.toContain(ROTATED);
  });

  it("sends a test and shows the receiver's answer under the row", async () => {
    sdk.postApiV1AdminWebhooksByIdTest.mockImplementation(() =>
      ok({ delivery: delivery({ kind: "test", topic: "webhook.test", status: "failed", responseStatus: 500, durationMs: 1840, error: "Receiver answered 500" }) }));
    await render(MANAGER, true);
    await vi.waitFor(() => expect(text()).toContain("https://hooks.example.com/scalius"));

    await openMenu("hooks.example.com");
    await chooseMenuItem("Send test");
    expect(sdk.postApiV1AdminWebhooksByIdTest).toHaveBeenCalledWith({ path: { id: "whs_1" }, body: {} });
    await vi.waitFor(() => expect(text()).toContain("Test failed · HTTP 500 · 1.8 s"));
    expect(text()).toContain("Receiver answered 500");
  });

  it("speaks Bangla, keeping status codes in Latin digits", async () => {
    setLocale("bn");
    listWith(subscription({ status: "disabled", disabledReason: "failing", failureStreak: 12 }));
    sdk.postApiV1AdminWebhooksByIdTest.mockImplementation(() =>
      ok({ delivery: delivery({ kind: "test", topic: "webhook.test", responseStatus: 200, durationMs: 90 }) }));
    await render(MANAGER, true);
    await vi.waitFor(() => expect(text()).toContain("১টি ওয়েবহুক বন্ধ করে দেওয়া হয়েছে"));
    expect(text()).toContain("বন্ধ — বারবার ব্যর্থ");
    expect(text()).toContain("অর্ডারের সব ইভেন্ট");
    expect(text()).toContain("শেষ ১২টি ডেলিভারি ব্যর্থ হয়েছে");

    expect(await openMenu("hooks.example.com")).toContain("টেস্ট পাঠান");
    await chooseMenuItem("টেস্ট পাঠান");
    await vi.waitFor(() => expect(text()).toContain("টেস্ট ডেলিভারি হয়েছে · HTTP 200 · ৯০ মি.সে."));
  });

  it("is read-only without webhooks.manage: no create, edit, test, rotate or delete", async () => {
    await render(["webhooks.view"]);
    await vi.waitFor(() => expect(text()).toContain("https://hooks.example.com/scalius"));

    expect(text()).not.toContain("Create webhook");
    expect(await openMenu("hooks.example.com")).toEqual(["View deliveries"]);
  });

  it("renders nothing and reads nothing without webhooks.view", async () => {
    await render(["settings.general.view"]);
    expect(host.innerHTML).toBe("");
    expect(sdk.getApiV1AdminWebhooks).not.toHaveBeenCalled();
  });

  it("shows deliveries with their statuses, pages with the cursor and retries a failed one", async () => {
    sdk.getApiV1AdminWebhooksByIdDeliveries.mockImplementation(({ query }: { query: { cursor?: string } }) =>
      query.cursor === "cur_2"
        ? ok({ deliveries: [delivery({ id: "whd_3", topic: "product.updated", status: "cancelled", responseStatus: null, durationMs: null })], nextCursor: null })
        : ok({
            deliveries: [
              delivery(),
              delivery({
                id: "whd_2",
                topic: "order.paid",
                status: "exhausted",
                attempts: 8,
                responseStatus: 503,
                durationMs: 2400,
                error: "Receiver answered 503",
                responseExcerpt: "<html>Service Unavailable</html>",
              }),
            ],
            nextCursor: "cur_2",
          }),
    );
    sdk.postApiV1AdminWebhooksByIdDeliveriesByDeliveryIdRetry.mockImplementation(() =>
      ok({ delivery: delivery({ id: "whd_2", status: "pending" }) }));
    await render(MANAGER, true);
    await vi.waitFor(() => expect(text()).toContain("https://hooks.example.com/scalius"));

    await openMenu("hooks.example.com");
    await chooseMenuItem("View deliveries");
    await vi.waitFor(() => expect(text()).toContain("Out of retries"));
    expect(sdk.getApiV1AdminWebhooksByIdDeliveries).toHaveBeenCalledWith({
      path: { id: "whs_1" },
      query: { status: undefined, cursor: undefined, limit: 25 },
    });
    const sheet = dialog();
    expect(sheet.textContent).toContain("Delivered");
    expect(sheet.textContent).toContain("Order paid");
    expect(sheet.textContent).toContain("503");
    expect(sheet.textContent).toContain("2.4 s");
    expect(sheet.textContent).toContain("132 ms");
    expect(sheet.textContent).toContain("8/8");

    const details = [...sheet.querySelectorAll<HTMLButtonElement>('button[aria-label^="Details"]')];
    await click(details[1]!);
    expect(sheet.textContent).toContain("Receiver answered 503");
    expect(sheet.querySelector("pre")?.textContent).toBe("<html>Service Unavailable</html>");
    await click(button("Retry", sheet));
    expect(sdk.postApiV1AdminWebhooksByIdDeliveriesByDeliveryIdRetry).toHaveBeenCalledWith({
      path: { id: "whs_1", deliveryId: "whd_2" },
    });
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Retry queued"));

    // A delivered one has nothing to retry.
    await click(details[0]!);
    expect(buttons("Retry", sheet)).toHaveLength(0);

    await click(button("Load more", sheet));
    await vi.waitFor(() => expect(sheet.textContent).toContain("Cancelled"));
    expect(sdk.getApiV1AdminWebhooksByIdDeliveries).toHaveBeenCalledWith({
      path: { id: "whs_1" },
      query: { status: undefined, cursor: "cur_2", limit: 25 },
    });
  });

  it("lets viewers read deliveries but not retry them", async () => {
    sdk.getApiV1AdminWebhooksByIdDeliveries.mockImplementation(() =>
      ok({ deliveries: [delivery({ status: "failed", responseStatus: 500, error: "Receiver answered 500" })], nextCursor: null }));
    await render(["webhooks.view"]);
    await vi.waitFor(() => expect(text()).toContain("https://hooks.example.com/scalius"));

    await openMenu("hooks.example.com");
    await chooseMenuItem("View deliveries");
    await vi.waitFor(() => expect(dialog().textContent).toContain("Failed"));
    await click(dialog().querySelector<HTMLButtonElement>('button[aria-label^="Details"]')!);
    expect(dialog().textContent).toContain("Receiver answered 500");
    expect(buttons("Retry", dialog())).toHaveLength(0);
  });
});
