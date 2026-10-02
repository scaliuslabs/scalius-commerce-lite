// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { storeTransferMessages } from "~/i18n/store-transfer";

const sdk = vi.hoisted(() => ({
  postApiV1AdminImportProducts: vi.fn(),
  postApiV1AdminImportProductImages: vi.fn(),
  postApiV1AdminImportCustomers: vi.fn(),
  postApiV1AdminImportInventory: vi.fn(),
  getApiV1AdminSettingsCurrency: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", symbol: "৳", fmt: String }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: unknown }) => children }));

import { ImportDialog } from "./LazyImportDialog";
import { ImportPreview } from "./ImportPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof storeTransferMessages.en, vars?: Record<string, string | number>) => translate(storeTransferMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });

const CSV = [
  "Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Option3 Name,Option3 Value,Variant SKU,Variant Inventory Tracker,Variant Inventory Qty,Variant Price,Variant Compare At Price,Image Src,Image Position,Status",
  "clay-mug,মাটির মগ,<p>হাতে তৈরি মাটির মগ।</p>,Mati,Home > Kitchen,kitchen,TRUE,Title,Default Title,,,,,MUG-350,shopify,12,450,500,https://cdn.example.com/mug.jpg,1,active",
  "saree,Jamdani Saree,<p>Woven on a handloom.</p>,Tant,Women,,TRUE,Color,Red,Size,Free,Fabric,Silk,SAREE-RFS,shopify,2,9500,,,,active",
  ",Saree,,,,,,,,,,,,,,,,,,,",
  "saree,,,,,,,,Red,,Free,,Cotton,SAREE-RFC,shopify,2,4200,,,,",
  "lamp,Brass Lamp,<p>Hand-beaten brass lamp.</p>,Mati,Home,,TRUE,Title,Default Title,,,,,LAMP-1,shopify,5,call us,,,,active",
].join("\n");

const buttonNamed = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);

describe("import dialog", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // Dry run: everything would be created; write: created with ids.
    sdk.postApiV1AdminImportProducts.mockImplementation(({ body }: { body: { dryRun?: boolean; items: Array<{ ref: string }> } }) => ok({
      results: body.items.map((item, index) => body.dryRun
        ? { ref: item.ref, status: "would_create", productId: null, slug: null, aggregateRevision: null, issues: [] }
        : { ref: item.ref, status: "created", productId: `prod_${index}`, slug: item.ref, aggregateRevision: 1, issues: [] }),
      processed: body.items.length,
      stoppedEarly: false,
      references: { brandsToCreate: body.dryRun ? ["Mati", "Tant"] : [], categoriesToCreate: body.dryRun ? ["Home", "Home > Kitchen", "Women"] : [], attributesToCreate: [] },
      notes: [],
    }));
    sdk.postApiV1AdminImportProductImages.mockImplementation(({ body }: { body: { items: Array<{ productId: string; images: Array<{ url: string }> }> } }) => ok({
      results: body.items.map((item) => ({ productId: item.productId, aggregateRevision: 2, error: null, images: item.images.map((image) => ({ url: image.url, status: "attached", mediaId: "media_u1", message: null })) })),
      stoppedEarly: false,
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function openWithFile() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportDialog kind="products" open onOpenChange={() => undefined} />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(document.querySelector("input[type=file]")).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    const file = new File([CSV], "shopify.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(document.querySelector("[data-testid=import-preview]")).not.toBeNull());
    await vi.waitFor(() => expect(document.body.textContent).toContain(t("statCreate")));
  }

  it("previews a Shopify file: counts, new records, Option3 choice, problems and what can't be imported", async () => {
    await openWithFile();
    const text = document.body.textContent!;
    expect(text).toContain(t("detected", { format: t("format_shopify_products"), rows: 5 }));
    expect(text).toContain(t("summaryProducts", { count: 2, variants: 3, images: 1 }));
    expect(text).toContain(t("newRecords", { list: [t("newBrands", { count: 2 }), t("newCategories", { count: 3 })].join(", ") }));
    expect(text).toContain(t("option3Title", { count: 1 }));
    // The broken lamp is reported with its line; the Bangla title arrives intact.
    expect(text).toContain(t("lineLabel", { line: 6 }));
    expect(text).toContain("Price \"call us\" is not a number.");
    expect(text).toContain(t("cantImport"));
    expect(sdk.postApiV1AdminImportProducts.mock.calls[0]![0].body.items[0].title).toBe("মাটির মগ");
    expect(buttonNamed(t("startProducts", { count: 2 }))).toBeDefined();
  });

  it("re-runs the dry run when the Option3 choice changes", async () => {
    await openWithFile();
    const before = sdk.postApiV1AdminImportProducts.mock.calls.length;
    await act(async () => document.getElementById(document.querySelector("label[for$='-fold'], label[for='import-option3-fold']")!.getAttribute("for")!)!.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminImportProducts.mock.calls.length).toBeGreaterThan(before));
    const refs = sdk.postApiV1AdminImportProducts.mock.calls.at(-1)![0].body.items.map((item: { ref: string }) => item.ref);
    expect(refs).toEqual(["clay-mug", "saree (Silk)", "saree (Cotton)"]);
  });

  it("imports in batches, then attaches images, and shows the summary", async () => {
    await openWithFile();
    await act(async () => buttonNamed(t("startProducts", { count: 2 }))!.click());
    await vi.waitFor(() => expect(document.querySelector("[data-testid=import-done]")).not.toBeNull());
    const writes = sdk.postApiV1AdminImportProducts.mock.calls.filter(([options]) => !options.body.dryRun);
    expect(writes).toHaveLength(1);
    expect(writes[0]![0].body.mode).toBe("create");
    expect(sdk.postApiV1AdminImportProductImages).toHaveBeenCalledWith({
      body: { items: [{ productId: "prod_0", images: [{ url: "https://cdn.example.com/mug.jpg", alt: null, skus: [] }] }] },
    });
    expect(document.body.textContent).toContain(t("doneTitle"));
    expect(document.body.textContent).toContain(t("imagesResult", { attached: 1, failed: 0 }));
  });
});

describe("import preview", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the checking progress, then the four counts, and caps the inline problems", async () => {
    const issues = Array.from({ length: 60 }, (_, index) => ({ severity: "error" as const, code: "price_invalid", message: `Price ${index} is not a number.`, line: index + 2, subject: `SKU-${index}` }));
    const props = {
      heading: "Shopify product CSV · 60 rows",
      summary: "60 products",
      stats: { create: 3, update: 1, skip: 2, failed: 60 },
      notes: ["Prices are imported as they are, in BDT."],
      unsupported: [{ code: "product_tags", message: "Product tags.", count: 4, examples: ["clay-mug"] }],
      issues,
      onDownloadReport: vi.fn(),
      onDownloadFailedRows: vi.fn(),
    };
    await act(async () => root.render(<ImportPreview {...props} checking={{ done: 20, total: 60 }} />));
    expect(container.textContent).toContain(t("checking", { done: 20, total: 60 }));
    expect(container.textContent).not.toContain(t("statCreate"));

    await act(async () => root.render(<ImportPreview {...props} checking={null} />));
    expect(container.textContent).toContain(t("statCreate"));
    expect(container.querySelectorAll("li .font-mono, li code")).toHaveLength(50);
    expect(container.textContent).toContain(t("moreProblems", { count: 10 }));
    expect(container.textContent).toContain(t("problemsCount", { errors: 60, warnings: 0 }));
    await act(async () => buttonNamed(t("downloadFailedRows"))!.click());
    expect(props.onDownloadFailedRows).toHaveBeenCalledTimes(1);
  });
});
