// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";
import { storefrontSourcePath } from "./test-source-paths";

function pollingScript(): string {
  const page = readFileSync(
    storefrontSourcePath("pages", "order-success.astro"),
    "utf8",
  );
  const marker = page.indexOf("const PAYMENT_STATUS_DELAYS_MS");
  const end = page.indexOf("</script>", marker);
  if (marker < 0 || end < 0) throw new Error("Receipt polling script was not found");
  return ts.transpileModule(page.slice(marker, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete window.__CHECKOUT_LANGUAGE__;
});

describe("pending Stripe receipt polling", () => {
  it("keeps actionable guidance, falls back truthfully, and reloads only for receipt changes", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    document.body.innerHTML = `
      <section
        data-order-success-state="payment_pending"
        data-order-id="order_1"
        data-order-updated-at="2026-09-09T00:00:00.000Z"
        data-payment-method="stripe"
      >
        <p data-payment-status-message>Checking payment status…</p>
        <button data-payment-check-now class="hidden">Check payment status</button>
      </section>
    `;
    window.__CHECKOUT_LANGUAGE__ = {
      languageData: ENGLISH_CHECKOUT_LANGUAGE_DATA,
    } as never;

    let resolveDeferredProvider!: (response: Response) => void;
    const deferredProvider = new Promise<Response>((resolve) => {
      resolveDeferredProvider = resolve;
    });
    const providerResponses = [
      response({
        success: true,
        data: { status: "pending", providerStatus: "requires_payment_method" },
      }),
      response({
        success: true,
        data: { status: "pending", providerStatus: "requires_action" },
      }),
      deferredProvider,
      response({
        success: true,
        data: { status: "pending", providerStatus: "processing" },
      }),
      response({
        success: true,
        data: { status: "pending", providerStatus: "requires_action" },
      }, 503),
      response({
        success: false,
        data: { status: "pending", providerStatus: "requires_action" },
      }),
      response({ success: false, error: "Unavailable" }, 503),
    ];
    let receiptChanged = false;
    let receiptChecks = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/checkout/stripe-reconcile") {
        return providerResponses.shift() ?? response({ success: false }, 503);
      }
      receiptChecks += 1;
      return response({
        success: true,
        data: receiptChanged
          ? { state: "order_updated", updatedAt: "2026-09-09T00:01:00.000Z" }
          : { state: "payment_pending", updatedAt: "2026-09-09T00:00:00.000Z" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);

    new Function("ENGLISH_CHECKOUT_LANGUAGE_DATA", pollingScript())(
      ENGLISH_CHECKOUT_LANGUAGE_DATA,
    );
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await settle();

    const message = document.querySelector<HTMLElement>("[data-payment-status-message]")!;
    const checkNow = document.querySelector<HTMLButtonElement>("[data-payment-check-now]")!;
    expect(fetchMock).not.toHaveBeenCalled();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(message.textContent).toContain("new card details");

    await vi.runAllTimersAsync();
    expect(message.textContent).toContain("new card details");
    expect(fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/checkout/stripe-reconcile",
    )).toHaveLength(1);

    checkNow.click();
    await settle();
    expect(message.textContent).toContain("authentication");

    const receiptChecksBeforeHide = receiptChecks;
    checkNow.click();
    checkNow.click();
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    resolveDeferredProvider(response({
      success: true,
      data: { status: "pending", providerStatus: "requires_action" },
    }));
    await settle();
    expect(receiptChecks).toBe(receiptChecksBeforeHide);
    expect(fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/checkout/stripe-reconcile",
    )).toHaveLength(3);

    visibilityState = "visible";
    const pageshow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    await settle();
    expect(message.textContent).toBe(
      ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptCheckingPaymentText,
    );
    expect(fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/checkout/stripe-reconcile",
    )).toHaveLength(4);

    await vi.runAllTimersAsync();
    expect(message.textContent).toBe(
      ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptConfirmationDelayedText,
    );
    expect(fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/checkout/stripe-reconcile",
    )).toHaveLength(4);

    checkNow.click();
    await settle();
    expect(message.textContent).toBe(
      ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptConfirmationDelayedText,
    );

    checkNow.click();
    await settle();
    expect(message.textContent).toBe(
      ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptConfirmationDelayedText,
    );

    checkNow.click();
    await settle();
    expect(message.textContent).toBe(
      ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptConfirmationDelayedText,
    );
    expect(fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/checkout/stripe-reconcile",
    )).toHaveLength(7);
    expect(reload).not.toHaveBeenCalled();

    receiptChanged = true;
    checkNow.click();
    await settle();
    expect(message.textContent).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptStatusUpdatedText);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/checkout/stripe-reconcile",
    )).toHaveLength(8);

    expect(BANGLA_CHECKOUT_LANGUAGE_DATA.orderReceiptStripePaymentMethodRequiredText).toContain("কার্ড");
    expect(BANGLA_CHECKOUT_LANGUAGE_DATA.orderReceiptStripeAuthenticationRequiredText).toContain("যাচাই");
  });
});
