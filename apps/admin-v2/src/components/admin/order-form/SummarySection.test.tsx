// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  discountValue: 200 as number | null,
  shippingValue: 10,
  localTotals: { subtotal: 100, shipping: 10, discount: 200, total: -90 },
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
  Loader2: () => null,
  RotateCcw: () => null,
}));

// No shipping-rate access in these tests: the delivery method picker stays hidden.
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("react-hook-form", () => ({ useWatch: () => ["", "", null, null] }));
vi.mock("~/contexts/PermissionContext", () => ({
  usePermissions: () => ({ hasPermission: () => false }),
}));
vi.mock("~/components/ui/select", () => ({
  Select: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
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
    localTotals: testState.localTotals,
    manualQuote: testState.manualQuote,
  }),
}));

vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({
    fmt: (n: number) => `${n < 0 ? "-" : ""}৳${Math.abs(n).toFixed(2)}`,
  }),
}));

import { SummarySection } from "./SummarySection";
import { orderFormMessages } from "~/i18n/order-form";
import { resourceMessages } from "~/i18n/resource";

const en = orderFormMessages.en;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("manual-order summary discount recovery", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testState.discountValue = 200;
    testState.shippingValue = 10;
    testState.localTotals = { subtotal: 100, shipping: 10, discount: 200, total: -90 };
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
    expect(discountInput.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain(en.discountTooHigh.replace("{amount}", "৳100.00"));
    expect(host.textContent).toContain(en.fixDiscount);
    expect(host.textContent).not.toContain("-৳90.00");
    expect(host.textContent).not.toContain(resourceMessages.en.retry);

    const remove = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === en.removeDiscount,
    );
    if (!remove) throw new Error("Expected remove-discount action");
    await act(async () => remove.click());
    expect(testState.setValue).toHaveBeenCalledWith("discountAmount", null, {
      shouldDirty: true,
      shouldValidate: true,
    });
  });

  it("accepts the exact item boundary while preserving shipping due", async () => {
    testState.discountValue = 100;
    testState.localTotals = { ...testState.localTotals, discount: 100, total: 10 };
    testState.manualQuote.discountLimit = {
      maximumAmount: 100,
      exceeded: false,
      source: "local",
      currencyCode: "BDT",
      decimalPlaces: 2,
    };

    await act(async () => root.render(<SummarySection />));
    expect(host.textContent).not.toContain(en.fixDiscount);
    expect(host.textContent).toContain("৳10.00");
  });

  it("keeps Retry only for a failure that may succeed unchanged", async () => {
    testState.discountValue = null;
    testState.localTotals = { ...testState.localTotals, discount: 0, total: 110 };
    testState.manualQuote.discountLimit = null;
    testState.manualQuote.errorMessage = "Could not calculate the order total";
    testState.manualQuote.canRetry = true;

    await act(async () => root.render(<SummarySection />));
    const retry = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes(resourceMessages.en.retry),
    );
    if (!retry) throw new Error("Expected retry action");
    await act(async () => retry.click());
    expect(testState.manualQuote.retry).toHaveBeenCalledTimes(1);
  });

  it("never shows a negative delivery charge in the total", async () => {
    testState.discountValue = null;
    testState.shippingValue = -20;
    testState.localTotals = { subtotal: 100, shipping: -20, discount: 0, total: 80 };
    testState.manualQuote.discountLimit = null;

    await act(async () => root.render(<SummarySection />));
    expect(host.textContent).not.toContain("-৳20");
    expect(host.textContent).toContain(en.fixDeliveryCharge);
  });

  it("does not offer Retry for a deterministic non-discount validation error", async () => {
    testState.manualQuote.discountLimit = null;
    testState.manualQuote.errorMessage = "Selected zone is no longer available.";
    testState.manualQuote.canRetry = false;

    await act(async () => root.render(<SummarySection />));
    expect(host.textContent).toContain("Selected zone is no longer available.");
    expect(host.textContent).not.toContain(resourceMessages.en.retry);
  });
});
