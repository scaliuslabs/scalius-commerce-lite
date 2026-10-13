// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digitalMessages } from "~/i18n/digital";
import { resourceMessages } from "~/i18n/resource";

const sdk = vi.hoisted(() => ({
  assets: vi.fn(), create: vi.fn(), patch: vi.fn(), remove: vi.fn(), importKeys: vi.fn(), revoke: vi.fn(),
  start: vi.fn(), resume: vi.fn(), send: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminProductsByIdDigitalAssets: sdk.assets,
  postApiV1AdminProductsByIdDigitalAssets: sdk.create,
  patchApiV1AdminDigitalAssetsById: sdk.patch,
  deleteApiV1AdminDigitalAssetsById: sdk.remove,
  postApiV1AdminDigitalAssetsByIdLicenceKeys: sdk.importKeys,
  getApiV1AdminDigitalAssetsByIdLicenceKeys: vi.fn(async () => ({ keys: [], nextCursor: null })),
  postApiV1AdminDigitalAssetsByIdLicenceKeysRevoke: sdk.revoke,
}));
vi.mock("~/lib/api", () => ({ apiData: (value: unknown) => Promise.resolve(value) }));
vi.mock("~/lib/api-query-options/products", () => ({
  productQueryOptions: (id: string) => ({ queryKey: ["digital-test-product", id], queryFn: async () => ({
    variants: [{ id: "var_1", sku: "BOOK", deletedAt: null, fulfillmentKind: "digital", trackInventory: true, selectedOptions: [] }],
  }) }),
}));
vi.mock("./digital-upload", () => ({
  fileInput: (file: File) => ({ filename: file.name, sizeBytes: file.size, mediaType: file.type }),
  startDigitalUpload: sdk.start, resumeOrRestart: sdk.resume, sendDigitalFile: sdk.send,
}));

import { DigitalDeliveryPanel } from "./DigitalDeliveryPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = digitalMessages.en;
const fileAsset = {
  id: "file_1", kind: "file", displayName: "Handbook", filename: "handbook.pdf", sizeBytes: 100,
  status: "ready", variantId: null, downloadLimit: 5, accessDays: null, deliveredCount: 0, hasFile: true, version: 1,
};
const pool = { id: "pool_1", kind: "licence_keys", status: "ready", variantId: "var_1", keys: { available: 2, assigned: 1 } };
const button = (label: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === label)!;
const chooseFile = async () => act(async () => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["content"], "book.pdf", { type: "application/pdf" })] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
});

describe("digital delivery permission boundary", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks();
    sdk.assets.mockResolvedValue({ assets: [fileAsset, pool] });
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });
  const render = (readOnly: boolean) => act(async () => root.render(
    <QueryClientProvider client={client}><DigitalDeliveryPanel productId="prod_1" readOnly={readOnly} /></QueryClientProvider>,
  ));
  const loaded = () => vi.waitFor(() => expect(host.textContent).toContain("Handbook"));
  const assertNoWrites = () => {
    for (const mock of [sdk.create, sdk.patch, sdk.remove, sdk.importKeys, sdk.revoke, sdk.start, sdk.resume, sdk.send]) {
      expect(mock).not.toHaveBeenCalled();
    }
  };

  it("lets a viewer retry failed reads and displays file/key facts without mutation controls", async () => {
    sdk.assets.mockRejectedValueOnce(new Error("offline"));
    await render(true);
    await vi.waitFor(() => expect(button(resourceMessages.en.retry)).toBeDefined());
    expect(button(resourceMessages.en.retry).matches(":disabled")).toBe(false);
    await act(async () => button(resourceMessages.en.retry).click());
    await loaded();
    expect(sdk.assets).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("2 available");
    expect(host.textContent).toContain("5 downloads per purchase");
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    // A file-picker result can arrive after the role changed.
    await chooseFile();
    assertNoWrites();
  });

  it.each(["edit", "delete", "importKeys", "revokeUnused"] as const)("unmounts %s on revocation and does not reopen it on regrant", async (action) => {
    await render(false);
    await loaded();
    if (action === "edit" || action === "delete") {
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Actions for Handbook"]')!;
      await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent === en[action])!;
      await act(async () => item.click());
    } else {
      await act(async () => button(en[action]).click());
    }
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).not.toBeNull();
    if (action === "edit") {
      const input = document.querySelector<HTMLInputElement>("#digital-file-name")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Unsaved name");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await render(true);
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    await render(false);
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    assertNoWrites();
  });

  it("does not send bytes when permission is revoked while asset creation is pending", async () => {
    let resolve!: (value: unknown) => void;
    sdk.create.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render(false);
    await loaded();
    await chooseFile();
    expect(sdk.create).toHaveBeenCalledTimes(1);
    await render(true);
    await act(async () => resolve({ asset: fileAsset, upload: { id: "upload_1" } }));
    expect(sdk.send).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
    expect(sdk.remove).not.toHaveBeenCalled();
  });

  it("aborts an active upload on revocation without deleting the saved asset", async () => {
    let signal!: AbortSignal;
    sdk.create.mockResolvedValue({ asset: fileAsset, upload: { id: "upload_1" } });
    sdk.send.mockImplementation((args: { signal: AbortSignal }) => {
      signal = args.signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    await render(false);
    await loaded();
    await chooseFile();
    expect(signal.aborted).toBe(false);
    await render(true);
    expect(signal.aborted).toBe(true);
    expect(host.textContent).not.toContain(en.cancelUpload);
    expect(sdk.remove).not.toHaveBeenCalled();
  });
});
