// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digitalMessages } from "~/i18n/digital";
import type { ProductFormValues } from "./types";

const sdk = vi.hoisted(() => ({ createAsset: vi.fn(), importKeys: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminProductsByIdDigitalAssets: sdk.createAsset,
  postApiV1AdminDigitalAssetsByIdLicenceKeys: sdk.importKeys,
  getApiV1AdminDigitalAssetsByIdLicenceKeys: vi.fn(),
  postApiV1AdminDigitalAssetsByIdLicenceKeysRevoke: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ apiData: (value: unknown) => Promise.resolve(value) }));

import { KeyImportDialog } from "./DigitalKeyDialogs";
import { DigitalDeliveryCard } from "./DigitalDeliveryCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = digitalMessages.en;

function setText(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("digital delivery", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });
  const button = (label: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === label);

  it("stays away from physical products and gift cards", async () => {
    function Harness({ values }: { values: Partial<ProductFormValues> }) {
      const form = useForm<ProductFormValues>({ defaultValues: values as ProductFormValues });
      return <DigitalDeliveryCard form={form} productId="prod_1" readOnly={false} />;
    }
    await act(async () => root.render(<Harness values={{ fulfillmentKind: "physical", isGiftCard: false }} />));
    expect(host.innerHTML).toBe("");
    await act(async () => root.render(<Harness key="gift" values={{ fulfillmentKind: "digital", isGiftCard: true }} />));
    expect(host.innerHTML).toBe("");
  });

  it("checks pasted keys, makes the pool on the first import and forgets the keys afterwards", async () => {
    const onOpenChange = vi.fn();
    const onChanged = vi.fn();
    const render = (open: boolean) => act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <KeyImportDialog
          productId="prod_1"
          target={open ? { variantId: "var_1", label: null, poolId: null } : null}
          onOpenChange={onOpenChange}
          onChanged={onChanged}
        />
      </QueryClientProvider>,
    ));
    await render(true);
    expect(button(en.importSubmit)?.disabled).toBe(true);
    const textarea = document.querySelector<HTMLTextAreaElement>("#licence-keys-text")!;
    await act(async () => setText(textarea, "AAAA-1111\nBBBB-2222\nAAAA-1111\n\n"));
    expect(document.body.textContent).toContain("2 keys to import");
    expect(document.body.textContent).toContain("Line 3: repeated");

    sdk.createAsset.mockResolvedValue({ asset: { id: "dga_pool" }, upload: null });
    sdk.importKeys.mockResolvedValue({ imported: 2, alreadyInPool: 0, rejected: [], replayed: false, stock: 2 });
    await act(async () => button(en.importSubmit)!.click());
    expect(sdk.createAsset).toHaveBeenCalledWith({ path: { id: "prod_1" }, body: { kind: "licence_keys", variantId: "var_1" } });
    expect(sdk.importKeys).toHaveBeenCalledWith({
      path: { id: "dga_pool" },
      body: { requestKey: expect.any(String), keys: ["AAAA-1111", "BBBB-2222"] },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalled();

    await render(false);
    await render(true);
    expect(document.querySelector<HTMLTextAreaElement>("#licence-keys-text")!.value).toBe("");
  });

  it("refuses more than 500 keys at once", async () => {
    await act(async () => root.render(
      <KeyImportDialog productId="prod_1" target={{ variantId: "var_1", label: "Pro", poolId: "dga_pool" }} onOpenChange={vi.fn()} onChanged={vi.fn()} />,
    ));
    const keys = Array.from({ length: 501 }, (_, index) => `KEY-${index}`).join("\n");
    await act(async () => setText(document.querySelector<HTMLTextAreaElement>("#licence-keys-text")!, keys));
    expect(document.body.textContent).toContain(en.tooMany);
    expect(button(en.importSubmit)?.disabled).toBe(true);
  });
});
