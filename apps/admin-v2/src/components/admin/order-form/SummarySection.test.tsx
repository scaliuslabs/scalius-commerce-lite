// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  discountValue: 200 as number | null,
  shippingValue: 10,
  calculations: {
    items: [],
    subtotal: 100,
    shippingCharge: 10,
    discountAmount: 200 as number | null,
    total: -90,
  },
  manualQuote: {
    data: null,
    isCurrent: false,
    isLoading: false,
    discountLimit: {
      maximumAmount: 100,
      exceeded: true,
      source: "local" as const,
      currencyCode: "BDT",
      decimalPlaces: 2,
    } as {
      maximumAmount: number;
      exceeded: boolean;
      source: "local" | "server";
      currencyCode: string;
      decimalPlaces: number;
    } | null,
    errorMessage: null as string | null,
    canRetry: false,
    retry: vi.fn(),
  },
  setValue: vi.fn(),
  discountFieldChange: vi.fn(),
  shippingFieldChange: vi.fn(),
  updateDiscountAmount: vi.fn(),
  updateShippingCharge: vi.fn(),
}));

vi.mock("~/components/ui/card", () => ({
  Card: (props: React.HTMLAttributes<HTMLDivElement>) => <section {...props} />,
  CardContent: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  CardDescription: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props} />,
  CardHeader: (props: React.HTMLAttributes<HTMLDivElement>) => <header {...props} />,
  CardTitle: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h2 {...props} />,
}));

vi.mock("~/components/ui/form", () => ({
  FormControl: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  FormDescription: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props} />,
  FormItem: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  FormLabel: (props: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props} />,
  FormMessage: () => null,
  FormField: ({ name, render }: {
    name: "shippingCharge" | "discountAmount";
    render: (input: { field: Record<string, unknown> }) => React.ReactNode;
  }) => render({
    field: name === "discountAmount"
      ? {
          name,
          value: testState.discountValue,
          onChange: testState.discountFieldChange,
          onBlur: vi.fn(),
          ref: vi.fn(),
        }
      : {
          name,
          value: testState.shippingValue,
          onChange: testState.shippingFieldChange,
          onBlur: vi.fn(),
          ref: vi.fn(),
        },
  }),
}));

vi.mock("~/components/ui/input", () => ({
  Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => <input ref={ref} {...props} />,
  ),
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("lucide-react", () => ({
  CircleCheck: () => null,
  Loader2: () => null,
  PackageCheck: () => null,
  RotateCcw: () => null,
  WalletCards: () => null,
}));

vi.mock("../../../store/orderStore", () => ({
  getOrderCalculation: () => testState.calculations,
  subscribe: () => () => undefined,
  updateDiscountAmount: testState.updateDiscountAmount,
  updateShippingCharge: testState.updateShippingCharge,
}));

vi.mock("./OrderFormContext", () => ({
  useOrderForm: () => ({
    form: { control: {}, setValue: testState.setValue },
    refs: {
      shippingChargeRef: { current: null },
      discountAmountRef: { current: null },
      submitButtonRef: { current: null },
    },
    handleKeyDown: vi.fn(),
    isEdit: false,
    manualQuote: testState.manualQuote,
  }),
}));

vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT" }),
}));

import { SummarySection } from "./SummarySection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("manual-order summary discount recovery", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testState.discountValue = 200;
    testState.shippingValue = 10;
    testState.calculations = {
      items: [],
      subtotal: 100,
      shippingCharge: 10,
      discountAmount: 200,
      total: -90,
    };
    testState.manualQuote.data = null;
    testState.manualQuote.isCurrent = false;
    testState.manualQuote.isLoading = false;
    testState.manualQuote.discountLimit = {
      maximumAmount: 100,
      exceeded: true,
      source: "local",
      currencyCode: "BDT",
      decimalPlaces: 2,
    };
    testState.manualQuote.errorMessage = null;
    testState.manualQuote.canRetry = false;
    testState.manualQuote.retry.mockReset();
    testState.setValue.mockReset();
    testState.updateDiscountAmount.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("explains the current maximum, offers explicit removal, and hides a negative total", async () => {
    await act(async () => root.render(<SummarySection />));

    const discountInput = host.querySelector<HTMLInputElement>(
      'input[name="discountAmount"]',
    );
    if (!discountInput) throw new Error("Expected discount input");
    expect(discountInput.max).toBe("100");
    expect(discountInput.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain(
      "Discount can’t exceed ৳100.00 for the current items.",
    );
    expect(host.textContent).toContain("Needs correction");
    expect(host.textContent).not.toContain("৳-90.00");
    expect(host.textContent).not.toContain("Retry");

    const remove = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Remove discount",
    );
    if (!remove) throw new Error("Expected remove-discount action");
    await act(async () => remove.click());
    expect(testState.setValue).toHaveBeenCalledWith("discountAmount", null, {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(testState.updateDiscountAmount).toHaveBeenCalledWith(null);
  });

  it("accepts the exact item boundary while preserving shipping due", async () => {
    testState.discountValue = 100;
    testState.calculations = {
      ...testState.calculations,
      discountAmount: 100,
      total: 10,
    };
    testState.manualQuote.discountLimit = {
      maximumAmount: 100,
      exceeded: false,
      source: "local",
      currencyCode: "BDT",
      decimalPlaces: 2,
    };

    await act(async () => root.render(<SummarySection />));
    expect(host.textContent).not.toContain("Needs correction");
    expect(host.textContent).toContain("৳10.00");
  });

  it("keeps Retry only for a failure that may succeed unchanged", async () => {
    testState.discountValue = null;
    testState.calculations = {
      ...testState.calculations,
      discountAmount: null,
      total: 110,
    };
    testState.manualQuote.discountLimit = null;
    testState.manualQuote.errorMessage = "Could not calculate the order total";
    testState.manualQuote.canRetry = true;

    await act(async () => root.render(<SummarySection />));
    const retry = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Retry"),
    );
    if (!retry) throw new Error("Expected retry action");
    await act(async () => retry.click());
    expect(testState.manualQuote.retry).toHaveBeenCalledTimes(1);
  });

  it("does not offer Retry for a deterministic non-discount validation error", async () => {
    testState.manualQuote.discountLimit = null;
    testState.manualQuote.errorMessage = "Selected zone is no longer available.";
    testState.manualQuote.canRetry = false;

    await act(async () => root.render(<SummarySection />));
    expect(host.textContent).toContain("Selected zone is no longer available.");
    expect(host.textContent).not.toContain("Retry");
  });
});
