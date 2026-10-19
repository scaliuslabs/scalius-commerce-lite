// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { queryKeys } from "@/lib/query-keys";
import { OnlinePaymentNote } from "./OnlinePaymentNote";
import type { ProductFormValues } from "./types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ values }: { values: Partial<ProductFormValues> }) {
  const form = useForm<ProductFormValues>({ defaultValues: values as ProductFormValues });
  return <OnlinePaymentNote form={form} />;
}

describe("OnlinePaymentNote", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = async (values: Partial<ProductFormValues>, ready: boolean | null) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Home's setup-guide read already answered: the editor reuses it.
    client.setQueryData(queryKeys.dashboard.setupGuide(), { onlinePayment: { ready, blockedProducts: 0 } });
    await act(async () => root.render(
      <QueryClientProvider client={client}><Harness values={values} /></QueryClientProvider>,
    ));
  };

  it.each([
    { isActive: true, isGiftCard: false, fulfillmentKind: "digital" as const },
    { isActive: true, isGiftCard: true, fulfillmentKind: "physical" as const },
  ])("warns that an active product paid only online can't be bought on a cash-only checkout (%o)", async (values) => {
    await render(values, false);
    expect(host.textContent).toContain(translate(productMessages, "onlinePaymentNeededNote"));
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/admin/settings/payments");
  });

  it.each([
    [{ isActive: false, isGiftCard: false, fulfillmentKind: "digital" as const }, false],
    [{ isActive: true, isGiftCard: false, fulfillmentKind: "mixed" as const }, false],
    [{ isActive: true, isGiftCard: false, fulfillmentKind: "physical" as const }, false],
    [{ isActive: true, isGiftCard: false, fulfillmentKind: "digital" as const }, true],
    [{ isActive: true, isGiftCard: false, fulfillmentKind: "digital" as const }, null],
  ])("says nothing for %o when online payment ready is %s", async (values, ready) => {
    await render(values, ready);
    expect(host.querySelector("[data-online-payment-note]")).toBeNull();
  });
});
