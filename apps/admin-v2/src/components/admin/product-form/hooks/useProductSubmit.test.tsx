// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";

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
  onOpenRevisionConflict: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: {
    mutationFn: (values: unknown) => Promise<unknown>;
    onSuccess?: (result: unknown, values: unknown) => void;
    onError?: (error: unknown, values: unknown) => void;
  }) => ({
    isPending: false,
    mutateAsync: async (values: unknown) => {
      try {
        const result = await options.mutationFn(values);
        options.onSuccess?.(result, values);
        return result;
      } catch (error) {
        options.onError?.(error, values);
        throw error;
      }
    },
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("../utils", () => ({
  formatFormValuesForSubmission: (values: unknown) => values,
}));

vi.mock("~/lib/api-functions/products", () => ({
  createProduct: (input: unknown) => mocks.serverMutation(input),
  updateProduct: (input: unknown) => mocks.serverMutation(input),
}));

vi.mock("~/lib/api-helpers", () => ({
  getServerFnError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { useProductSubmit } from "./useProductSubmit";
import type { ProductFormValues } from "../types";
import type { ProductRevisionConflict } from "~/lib/admin-api-error";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("useProductSubmit", () => {
  let host: HTMLDivElement;
  let root: Root;
  let result: ReturnType<typeof useProductSubmit> | null;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
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

  it("does not report success until the server mutation settles", async () => {
    renderHarness();
    let resolveMutation: ((value: { id: string; aggregateRevision: number }) => void) | undefined;
    mocks.serverMutation.mockImplementationOnce(
      () =>
        new Promise<{ id: string; aggregateRevision: number }>((resolve) => {
          resolveMutation = resolve;
        }),
    );
    let settled = false;

    const submission = requireResult(result)
      .handleSubmit(productValues())
      .then((saved) => {
        settled = true;
        return saved;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    resolveMutation?.({ id: "prod_one", aggregateRevision: 1 });
    await expect(submission).resolves.toBe(true);
  });

  it("sends and advances the shared aggregate revision without remounting", async () => {
    renderHarness({ isEdit: true, aggregateRevision: 4 });
    mocks.serverMutation.mockResolvedValueOnce({ aggregateRevision: 5 });

    await expect(
      requireResult(result).handleSubmit(productValues()),
    ).resolves.toBe(true);

    expect(mocks.serverMutation).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "prod_one",
        expectedAggregateRevision: 4,
      }),
    });
    expect(mocks.formReset).toHaveBeenCalledTimes(1);
    expect(mocks.onAggregateRevisionChange).toHaveBeenCalledWith(5);

    renderHarness({ isEdit: true, aggregateRevision: 5 });
    mocks.serverMutation.mockResolvedValueOnce({ aggregateRevision: 6 });
    await expect(
      requireResult(result).handleSubmit(productValues()),
    ).resolves.toBe(true);
    expect(mocks.serverMutation).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ expectedAggregateRevision: 5 }),
    });
    expect(mocks.onAggregateRevisionChange).toHaveBeenLastCalledWith(6);
  });

  it("preserves the draft on typed conflict and blocks stale retries", async () => {
    const conflict = { expectedRevision: 6, currentRevision: 7 };
    renderHarness({ isEdit: true, aggregateRevision: 6 });
    mocks.serverMutation.mockRejectedValueOnce(
      new AdminApiResponseError(
        "This product changed while you were editing.",
        409,
        "PRODUCT_REVISION_CONFLICT",
        conflict,
      ),
    );

    await expect(
      requireResult(result).handleSubmit(productValues()),
    ).resolves.toBe(false);
    expect(mocks.onRevisionConflict).toHaveBeenCalledWith(conflict);
    expect(mocks.formReset).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();

    renderHarness({
      isEdit: true,
      aggregateRevision: 6,
      revisionConflict: conflict,
    });
    await expect(
      requireResult(result).handleSubmit(productValues()),
    ).resolves.toBe(false);
    expect(mocks.serverMutation).toHaveBeenCalledTimes(1);
    expect(mocks.onOpenRevisionConflict).toHaveBeenCalledTimes(1);
  });

  it("keeps generic failures out of the revision-conflict workflow", async () => {
    renderHarness({ isEdit: true, aggregateRevision: 2 });
    mocks.serverMutation.mockRejectedValueOnce(new Error("API unavailable"));

    await expect(
      requireResult(result).handleSubmit(productValues()),
    ).resolves.toBe(false);
    expect(mocks.onRevisionConflict).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("Error", {
      description: "API unavailable",
    });
  });

  it("requires explicit SKU fallback acknowledgement before removing assigned media", async () => {
    renderHarness({ isEdit: true, aggregateRevision: 4 });
    mocks.serverMutation.mockRejectedValueOnce(
      new AdminApiResponseError(
        "Removed images are assigned to SKUs.",
        409,
        "PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT",
        {
          affectedCount: 2,
          affectedAssociationIds: ["pmed_assigned_1"],
          affectedSkus: [
            { id: "var_white", sku: "TEA-WHITE", imageId: "pmed_assigned_1" },
          ],
        },
      ),
    );

    await act(async () => {
      await expect(requireResult(result).handleSubmit(productValues())).resolves.toBe(false);
    });
    expect(requireResult(result).mediaRemovalConflict).toMatchObject({ affectedCount: 2 });
    expect(mocks.formReset).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();

    mocks.serverMutation.mockResolvedValueOnce({ aggregateRevision: 5 });
    await act(async () => {
      await expect(requireResult(result).confirmMediaRemoval()).resolves.toBe(true);
    });

    expect(mocks.serverMutation).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        id: "prod_one",
        expectedAggregateRevision: 4,
        acknowledgedSkuImageRemovalIds: ["pmed_assigned_1"],
      }),
    });
    expect(mocks.formReset).toHaveBeenCalledTimes(1);
    expect(mocks.onAggregateRevisionChange).toHaveBeenCalledWith(5);
  });

  it("blocks product creation while an option draft needs attention", async () => {
    renderHarness({ optionMatrixIssue: "Update combinations before saving." });

    await act(async () => {
      await expect(requireResult(result).handleSubmit(productValues())).resolves.toBe(false);
    });

    expect(mocks.serverMutation).not.toHaveBeenCalled();
    expect(requireResult(result).showAlert).toBe(true);
    expect(requireResult(result).alertMessage).toBe("Update combinations before saving.");
  });

  function renderHarness({
    isEdit = false,
    aggregateRevision,
    revisionConflict = null,
    optionMatrixIssue = null,
  }: {
    isEdit?: boolean;
    aggregateRevision?: number;
    revisionConflict?: ProductRevisionConflict | null;
    optionMatrixIssue?: string | null;
  } = {}) {
    act(() => {
      root.render(
        <HookHarness
          isEdit={isEdit}
          aggregateRevision={aggregateRevision}
          revisionConflict={revisionConflict}
          optionMatrixIssue={optionMatrixIssue}
          onResult={(nextResult) => (result = nextResult)}
        />,
      );
    });
  }
});

function HookHarness({
  isEdit,
  aggregateRevision,
  revisionConflict,
  optionMatrixIssue,
  onResult,
}: {
  isEdit: boolean;
  aggregateRevision?: number;
  revisionConflict: ProductRevisionConflict | null;
  optionMatrixIssue: string | null;
  onResult: (result: ReturnType<typeof useProductSubmit>) => void;
}) {
  const form = {
    getValues: vi.fn(() => productValues()),
    reset: mocks.formReset,
    setError: mocks.formSetError,
  } as unknown as UseFormReturn<ProductFormValues>;
  const hookResult = useProductSubmit({
    isEdit,
    productId: isEdit ? "prod_one" : undefined,
    aggregateRevision,
    revisionConflict,
    optionMatrixIssue,
    onAggregateRevisionChange: mocks.onAggregateRevisionChange,
    onRevisionConflict: mocks.onRevisionConflict,
    onOpenRevisionConflict: mocks.onOpenRevisionConflict,
    form,
  });
  onResult(hookResult);
  return null;
}

function requireResult(
  result: ReturnType<typeof useProductSubmit> | null,
): ReturnType<typeof useProductSubmit> {
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
  };
}
