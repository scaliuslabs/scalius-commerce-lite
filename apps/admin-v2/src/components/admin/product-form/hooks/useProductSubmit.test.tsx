// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { queryKeys } from "~/lib/query-keys";
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { saveBarMessages } from "~/i18n/save-bar";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  serverMutation: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  formReset: vi.fn(),
  formSetError: vi.fn(),
  onAggregateRevisionChange: vi.fn(),
  onRevisionConflict: vi.fn(),
  onVariantIssue: vi.fn(),
  formatted: vi.fn(),
}));
/** The fields the merchant changed in the form under test. */
const dirty = vi.hoisted(() => ({ fields: {} as Record<string, unknown> }));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: {
    mutationFn: (values: unknown) => Promise<unknown>;
    onSuccess?: (result: unknown, values: unknown) => void | Promise<void>;
  }) => ({
    isPending: false,
    mutateAsync: async (values: unknown) => {
      const result = await options.mutationFn(values);
      await options.onSuccess?.(result, values);
      return result;
    },
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("../utils", async (importOriginal) => ({
  productSubmitChanges: (await importOriginal<typeof import("../utils")>()).productSubmitChanges,
  formatFormValuesForSubmission: (values: unknown, changed: unknown) => {
    mocks.formatted(values, changed);
    return values;
  },
}));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminProducts: (input: unknown) => mocks.serverMutation(input),
  putApiV1AdminProductsById: (input: unknown) => mocks.serverMutation(input),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { useProductSubmit } from "./useProductSubmit";
import type { ProductFormValues } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: ProductMessageKey, vars?: Record<string, string | number>) => translate(productMessages, key, vars);

describe("useProductSubmit", () => {
  let host: HTMLDivElement;
  let root: Root;
  let result: ReturnType<typeof useProductSubmit> | null;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    dirty.fields = {};
    result = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("resolves only after the server and the product fan-out settle, then opens the new product", async () => {
    renderHarness();
    mocks.serverMutation.mockResolvedValueOnce({ id: "prod_new", aggregateRevision: 1 });
    let releaseFirst: (() => void) | undefined;
    mocks.invalidateQueries
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue(undefined);
    let settled = false;
    const submission = requireResult(result).submit(productValues()).then((revision) => {
      settled = true;
      return revision;
    });

    await vi.waitFor(() => {
      expect(mocks.invalidateQueries.mock.calls.map(([options]) => options.queryKey)).toEqual([
        queryKeys.products.list(),
        queryKeys.products.byIds(),
        queryKeys.products.collectionOptions(),
        queryKeys.products.stats(),
        queryKeys.dashboard.all,
        queryKeys.inventory.list(),
        queryKeys.products.detail("prod_new"),
        queryKeys.products.variants("prod_new"),
      ]);
    });
    expect(settled).toBe(false);
    releaseFirst?.();
    await expect(submission).resolves.toBe(1);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/admin/products/$productId/edit", params: { productId: "prod_new" } });
  });

  it("sends a new product's web address only when the merchant typed it", async () => {
    renderHarness();
    mocks.serverMutation.mockResolvedValue({ id: "prod_new", aggregateRevision: 1 });

    await requireResult(result).submit(productValues());
    await requireResult(result).submit({ ...productValues(), slug: "tea-green", slugEdited: true });

    expect(mocks.serverMutation.mock.calls[0]?.[0]?.body?.slug).toBeUndefined();
    expect(mocks.serverMutation.mock.calls[1]?.[0]?.body?.slug).toBe("tea-green");
  });

  it("tells the payload which omit-to-keep fields the merchant changed", async () => {
    renderHarness({ isEdit: true, aggregateRevision: 4 });
    mocks.serverMutation.mockResolvedValue({ aggregateRevision: 5 });
    await requireResult(result).submit(productValues());
    expect(mocks.formatted.mock.calls[0]![1]).toEqual({
      customizationSchema: false, fulfillmentKind: false, isGiftCard: false, warrantyPolicyId: false, brandId: false,
    });

    dirty.fields = { customizationSchema: [{ label: true }], fulfillmentKind: true, isGiftCard: true, warrantyPolicyId: true, brandId: true };
    await requireResult(result).submit(productValues());
    expect(mocks.formatted.mock.calls[1]![1]).toEqual({
      customizationSchema: true, fulfillmentKind: true, isGiftCard: true, warrantyPolicyId: true, brandId: true,
    });
  });

  it("sends a new product's buyer inputs and fulfilment as they are", async () => {
    renderHarness({ isEdit: false });
    mocks.serverMutation.mockResolvedValue({ id: "prod_new", aggregateRevision: 1 });
    await requireResult(result).submit(productValues());
    expect(mocks.formatted.mock.calls[0]![1]).toBeUndefined();
  });

  it("sends and advances the shared aggregate revision", async () => {
    renderHarness({ isEdit: true, aggregateRevision: 4 });
    mocks.serverMutation.mockResolvedValueOnce({ aggregateRevision: 5 });

    await expect(requireResult(result).submit(productValues())).resolves.toBe(5);
    expect(mocks.serverMutation).toHaveBeenCalledWith({
      path: { id: "prod_one" },
      body: expect.objectContaining({ id: "prod_one", expectedAggregateRevision: 4 }),
    });
    expect(mocks.formReset).toHaveBeenCalledTimes(1);
    expect(mocks.onAggregateRevisionChange).toHaveBeenCalledWith(5);
  });

  it("keeps the draft on a revision conflict and explains it for the save banner", async () => {
    const conflict = { expectedRevision: 6, currentRevision: 7 };
    renderHarness({ isEdit: true, aggregateRevision: 6 });
    mocks.serverMutation.mockRejectedValueOnce(
      new AdminApiResponseError("This product changed.", 409, "PRODUCT_REVISION_CONFLICT", conflict),
    );

    await expect(requireResult(result).submit(productValues())).rejects.toMatchObject({
      name: "SaveNotCompleted",
      message: t("changedElsewhere"),
    });
    expect(mocks.onRevisionConflict).toHaveBeenCalledWith(conflict);
    expect(mocks.formReset).not.toHaveBeenCalled();
  });

  it("puts server rejections on their field: product fields in the form, SKUs in the variant editor", async () => {
    renderHarness({ isEdit: true, aggregateRevision: 2 });
    mocks.serverMutation.mockRejectedValueOnce(new AdminApiResponseError(
      JSON.stringify([{ code: "custom", path: ["price"], message: "Enter a price above 0 to make this product active." }]),
      400,
    ));
    await expect(requireResult(result).submit(productValues())).rejects.toMatchObject({
      lines: [`${t("price")}: Enter a price above 0 to make this product active.`],
    });
    expect(mocks.formSetError).toHaveBeenCalledWith("price", {
      type: "server",
      message: "Enter a price above 0 to make this product active.",
    });

    mocks.onVariantIssue.mockReturnValueOnce("M / White: taken");
    mocks.serverMutation.mockRejectedValueOnce(new AdminApiResponseError(
      "SKU TEE-M is already used by Cotton tee.",
      409,
      "SKU_TAKEN",
      { field: "optionMatrix.variants.1.sku", sku: "TEE-M", productId: "prod_x", productName: "Cotton tee" },
    ));
    await expect(requireResult(result).submit(productValues())).rejects.toMatchObject({ lines: ["M / White: taken"] });
    expect(mocks.onVariantIssue).toHaveBeenCalledWith(
      "optionMatrix.variants.1.sku",
      t("skuTaken", { sku: "TEE-M", product: "Cotton tee" }),
    );
  });

  it("never shows raw server faults", async () => {
    renderHarness({ isEdit: true, aggregateRevision: 2 });
    mocks.serverMutation.mockRejectedValueOnce(new AdminApiResponseError("Internal Server Error", 500));

    await expect(requireResult(result).submit(productValues())).rejects.toMatchObject({
      name: "SaveNotCompleted",
      message: translate(saveBarMessages, "serverError"),
    });
    expect(mocks.onRevisionConflict).not.toHaveBeenCalled();
  });

  it("requires explicit SKU fallback acknowledgement before removing assigned media", async () => {
    renderHarness({ isEdit: true, aggregateRevision: 4 });
    mocks.serverMutation.mockRejectedValueOnce(
      new AdminApiResponseError("Removed images are assigned to SKUs.", 409, "PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT", {
        affectedCount: 2,
        affectedAssociationIds: ["pmed_assigned_1"],
        affectedSkus: [{ id: "var_white", sku: "TEA-WHITE", imageId: "pmed_assigned_1" }],
      }),
    );

    await act(async () => {
      await expect(requireResult(result).submit(productValues())).rejects.toMatchObject({ name: "SaveNotCompleted" });
    });
    expect(requireResult(result).mediaRemovalConflict).toMatchObject({ affectedCount: 2 });
    expect(mocks.formReset).not.toHaveBeenCalled();

    mocks.serverMutation.mockResolvedValueOnce({ aggregateRevision: 5 });
    await act(async () => {
      await requireResult(result).confirmMediaRemoval();
    });
    expect(mocks.serverMutation).toHaveBeenLastCalledWith({
      path: { id: "prod_one" },
      body: expect.objectContaining({
        expectedAggregateRevision: 4,
        acknowledgedSkuImageRemovalIds: ["pmed_assigned_1"],
      }),
    });
    expect(mocks.onAggregateRevisionChange).toHaveBeenCalledWith(5);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t("productSaved"));
  });

  function renderHarness({ isEdit = false, aggregateRevision }: { isEdit?: boolean; aggregateRevision?: number } = {}) {
    act(() => {
      root.render(
        <HookHarness isEdit={isEdit} aggregateRevision={aggregateRevision} onResult={(next) => (result = next)} />,
      );
    });
  }
});

function HookHarness({ isEdit, aggregateRevision, onResult }: {
  isEdit: boolean;
  aggregateRevision?: number;
  onResult: (result: ReturnType<typeof useProductSubmit>) => void;
}) {
  const form = {
    getValues: vi.fn(() => productValues()),
    reset: mocks.formReset,
    setError: mocks.formSetError,
    get formState() {
      return { dirtyFields: dirty.fields };
    },
  } as unknown as UseFormReturn<ProductFormValues>;
  onResult(useProductSubmit({
    isEdit,
    productId: isEdit ? "prod_one" : undefined,
    aggregateRevision,
    onAggregateRevisionChange: mocks.onAggregateRevisionChange,
    onRevisionConflict: mocks.onRevisionConflict,
    onVariantIssue: mocks.onVariantIssue,
    form,
  }));
  return null;
}

function requireResult(result: ReturnType<typeof useProductSubmit> | null): ReturnType<typeof useProductSubmit> {
  if (!result) throw new Error("Hook result is unavailable");
  return result;
}

function productValues(): ProductFormValues {
  return {
    id: "prod_one",
    name: "Green Tea",
    description: "Fresh green tea leaves.",
    price: 1200,
    categoryId: "cat_tea",
    isActive: true,
    discountType: "percentage",
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    excludeFromProductFeed: false,
    productCondition: "new",
    slug: "green-tea",
    slugEdited: false,
    media: [],
    attributes: [],
    additionalInfo: [],
    fulfillmentKind: "physical",
    isGiftCard: false,
    warrantyPolicyId: null,
    brandId: null,
    customizationSchema: [],
  };
}
