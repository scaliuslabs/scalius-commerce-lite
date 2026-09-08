// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { escapeHtml } from "@scalius/shared/html-escape";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { getOrderPaymentPresentation, formatOrderSuccessPaymentMethod } from "./order-success-state";
import { resolveSavedOrderMoneySummary } from "./order-tax-presentation";

import {
  getAccountPaymentRecoveryAction,
  getAccountPaymentReturnNotice,
  normalizeHostedGatewayUrl,
} from "./account-payment-recovery";
import type { CustomerOrderDetail, CustomerPaymentRecovery } from "./api/customer-auth";
import { storefrontSourcePath } from "./test-source-paths";

function recovery(overrides: Partial<CustomerPaymentRecovery> = {}): CustomerPaymentRecovery {
  return {
    eligible: true,
    gateway: "sslcommerz",
    paymentType: "full",
    amountDue: 1200,
    label: "Retry payment",
    reason: null,
    requiresCardForm: false,
    hostedRedirect: true,
    ...overrides,
  };
}

describe("account payment recovery", () => {
  const accountPageSource = readFileSync(
    storefrontSourcePath("pages", "account", "orders", "[id].astro"),
    "utf8",
  );

  it("builds retry and balance actions from backend recovery policy", () => {
    expect(getAccountPaymentRecoveryAction(recovery())).toMatchObject({
      visible: true,
      gateway: "sslcommerz",
      title: "Payment needs attention",
      buttonLabel: "Retry payment",
      amountDue: 1200,
      hostedRedirect: true,
    });

    expect(
      getAccountPaymentRecoveryAction(recovery({
        paymentType: "balance",
        amountDue: 900,
        label: "Pay balance",
      })),
    ).toMatchObject({
      title: "Remaining balance is due",
      buttonLabel: "Pay balance",
      amountDue: 900,
    });
  });

  it("uses card copy for Stripe and hides ineligible recovery", () => {
    expect(
      getAccountPaymentRecoveryAction(recovery({
        gateway: "stripe",
        requiresCardForm: true,
        hostedRedirect: false,
      })),
    ).toMatchObject({
      buttonLabel: "Enter card details",
      requiresCardForm: true,
      hostedRedirect: false,
    });

    expect(getAccountPaymentRecoveryAction(recovery({ eligible: false }))).toBeNull();
  });

  it("normalizes account gateway return notices without trusting them as payment truth", () => {
    expect(getAccountPaymentReturnNotice("sslcommerz", "cancelled")).toMatchObject({
      tone: "warning",
      title: "Payment was cancelled",
    });
    expect(getAccountPaymentReturnNotice("polar", "failed")).toMatchObject({
      tone: "warning",
      title: "Payment did not complete",
    });
    expect(getAccountPaymentReturnNotice("stripe", null)).toMatchObject({
      tone: "info",
      title: "Payment submitted",
    });
    expect(getAccountPaymentReturnNotice("cod", "failed")).toBeNull();
  });

  it("accepts only absolute HTTP(S) hosted gateway URLs", () => {
    expect(normalizeHostedGatewayUrl("https://sandbox.sslcommerz.com/pay")).toBe(
      "https://sandbox.sslcommerz.com/pay",
    );
    expect(normalizeHostedGatewayUrl("http://localhost:8787/pay")).toBe(
      "http://localhost:8787/pay",
    );
    expect(normalizeHostedGatewayUrl("http://gateway.example/pay")).toBeNull();
    expect(normalizeHostedGatewayUrl("https://user:pass@gateway.example/pay")).toBeNull();
    expect(normalizeHostedGatewayUrl("/checkout")).toBeNull();
    expect(normalizeHostedGatewayUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeHostedGatewayUrl("")).toBeNull();
  });

  it("keeps balance recovery on the current gateway and replaces only untouched attempts", () => {
    expect(accountPageSource).toContain('currentDetail?.paymentRecovery.paymentType === "balance"');
    expect(accountPageSource).toContain("configuredGateway && isGatewayEligibleForPaymentAmount");
    expect(accountPageSource).toContain("? [recoveryAction.gateway] : [];");
    expect(accountPageSource).toContain(
      'replaceExistingAttempt: currentDetail.paymentRecovery.paymentType !== "balance"',
    );
    expect(accountPageSource).toContain('gateway === detail.order.paymentMethod ? "Current method" : "Change method"');
  });
});

describe("account timeline payment presentation", () => {
  const source = readFileSync(storefrontSourcePath("pages", "account", "orders", "[id].astro"), "utf8");
  const scriptSource = source.split("<script>")[1]!.split("  detailWindow.__scaliusLoadOrderDetail = loadOrder;")[0]!;
  const parsed = ts.createSourceFile("account-detail.ts", scriptSource, ts.ScriptTarget.ES2022, true);
  const script = ts.transpileModule(
    parsed.statements.filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => statement.getFullText(parsed)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;

  afterEach(() => { document.body.innerHTML = ""; });

  it.each([
    { status: "pending", method: "cod", paymentStatus: "unpaid", paid: 0, due: 1200, label: "Due on delivery", balance: "৳1200 due on delivery", eligible: false },
    { status: "pending", method: "cod", paymentStatus: "partial", paid: 300, due: 900, label: "Partially paid", balance: "৳900 due on delivery", eligible: false },
    { status: "cancelled", method: "cod", paymentStatus: "unpaid", paid: 0, due: 1200, label: "No payment due", balance: "No payment due", eligible: false },
    { status: "returned", method: "cod", paymentStatus: "partial", paid: 300, due: 900, label: "No payment due", balance: "No payment due", eligible: false },
    { status: "returned", method: "cod", paymentStatus: "paid", paid: 1200, due: 0, label: "Paid", balance: "No payment due", eligible: false },
    { status: "pending", method: "sslcommerz", paymentStatus: "paid", paid: 1200, due: 0, label: "Paid", balance: "No payment due", eligible: false },
    { status: "incomplete", method: "sslcommerz", paymentStatus: "failed", paid: 0, due: 1200, label: "Failed", balance: "৳1200 balance due", eligible: true },
    { status: "pending", method: "sslcommerz", paymentStatus: "partial", paid: 300, due: 900, label: "Partially paid", balance: "৳900 balance due", eligible: true },
    { status: "pending", method: "sslcommerz", paymentStatus: "partial", paid: 300, due: 900, label: "Partially paid", balance: "৳900 balance due", eligible: false },
  ])("renders $status $method $paymentStatus with recovery eligible=$eligible", (payment) => {
    document.body.innerHTML = `<div id="orderBadges"></div><div id="orderPayment"></div><div id="orderBalance"></div>
      <div id="orderPayments"></div><div id="orderPaymentRecovery" class="hidden">
        <p id="orderPaymentRecoveryTitle"></p><p id="orderPaymentRecoveryDescription"></p>
        <button id="orderPaymentRecoveryButton"></button>
      </div>`;
    const detail: CustomerOrderDetail = {
      order: {
        id: "order_1", invoiceNumber: null, status: payment.status, paymentMethod: payment.method,
        paymentStatus: payment.paymentStatus, totalAmount: 1200, paidAmount: payment.paid, balanceDue: payment.due,
        shippingCharge: 0, discountAmount: null, fulfillmentStatus: "pending", expectedDelivery: null,
        shippingAddress: "Address", city: "city_1", zone: "zone_1", area: null,
        cityName: null, zoneName: null, areaName: null, notes: null, createdAt: null, updatedAt: null,
      },
      items: [], shipments: [], payments: [], refundAttempts: [], activeRefundOperation: null,
      supportRequests: [], supportRequestActions: [], supportRequestIntro: "", notifications: [], timeline: [],
      paymentPlan: payment.paymentStatus === "partial" ? {
        totalAmount: 1200, depositAmount: payment.paid, balanceDue: payment.due, balanceDueDate: null,
        status: "active", depositPaidAt: null, balancePaidAt: null, createdAt: null, updatedAt: null,
      } : null,
      cod: payment.method === "cod" ? {
        codStatus: "pending", collectedAmount: payment.paid, deliveryAttempts: 0,
        failureReason: null, receiptUrl: null, lastAttemptAt: null, collectedAt: null, updatedAt: null,
      } : null,
      paymentRecovery: recovery({ eligible: payment.eligible, paymentType: payment.paymentStatus === "partial" ? "balance" : "full", amountDue: payment.due }),
    };
    const dependencies = {
      DEFAULT_CURRENCY, escapeHtml, ENGLISH_CHECKOUT_LANGUAGE_DATA, getOrderPaymentPresentation,
      formatOrderSuccessPaymentMethod, resolveSavedOrderMoneySummary, getAccountPaymentRecoveryAction,
    };
    const render = new Function(...Object.keys(dependencies), `${script}\ncurrentCheckoutConfig = { unavailable: true }; return renderDetail;`)(...Object.values(dependencies));
    render(detail);
    expect(document.getElementById("orderBadges")?.textContent).toContain(payment.label);
    expect(document.getElementById("orderPayment")?.textContent).toBe(payment.method === "cod" ? "Cash on delivery" : "Online payment (SSLCommerz)");
    expect(document.getElementById("orderBalance")?.textContent).toBe(payment.balance);
    expect(document.getElementById("orderPaymentRecovery")?.classList.contains("hidden")).toBe(!payment.eligible);
    const history = document.getElementById("orderPayments")!;
    expect(history.textContent).not.toMatch(/COD pending|Collection pending/);
    if (payment.method === "cod") {
      const codHistory = Array.from(history.querySelectorAll("article"))
        .find((article) => article.querySelector("h3")?.textContent === "Cash on delivery")!;
      expect(codHistory.querySelector("p")?.textContent).toBe(payment.balance === "No payment due" ? payment.label : payment.balance);
      expect(codHistory.querySelectorAll("p")).toHaveLength(payment.paid > 0 ? 2 : 1);
      if (payment.paid > 0) expect(history.textContent).toContain(`৳${payment.paid} collected`);
      if (payment.balance === "No payment due") expect(history.textContent).not.toMatch(/due on delivery|Balance/);
      else expect(history.textContent).toContain(payment.balance);
    }
    if (payment.eligible) expect(document.getElementById("orderPaymentRecoveryButton")?.textContent).toMatch(/Continue with SSLCommerz|Pay balance/);
  });
});
