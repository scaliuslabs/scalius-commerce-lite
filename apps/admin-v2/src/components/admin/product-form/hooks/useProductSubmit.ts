// src/components/admin/product-form/hooks/useProductSubmit.ts
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProductFormValues } from "../types";
import { formatFormValuesForSubmission } from "../utils";
import { useNavigate } from "@tanstack/react-router";
import {
  postApiV1AdminProducts,
  putApiV1AdminProductsById,
} from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import {
  AdminApiResponseError,
  readProductMediaSkuReferenceConflict,
  readProductRevisionConflict,
  type ProductMediaSkuReferenceConflict,
  type ProductRevisionConflict,
} from "~/lib/admin-api-error";
import { SaveNotCompleted } from "../../shared/use-form-save-bar";
import type { ProductCreateComposition } from "../variants/option-matrix-editor-model";
import { queryKeys } from "~/lib/query-keys";
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";

const t = (key: ProductMessageKey, vars?: Record<string, string | number>) => translate(productMessages, key, vars);

/** Product fields the page shows, with the label the save banner names them by. */
const FIELD_LABELS: Partial<Record<keyof ProductFormValues, ProductMessageKey>> = {
  name: "title",
  description: "description",
  price: "price",
  discountAmount: "discount",
  discountPercentage: "discount",
  categoryId: "category",
  slug: "webAddress",
};

interface UseProductSubmitOptions {
  isEdit: boolean;
  productId?: string;
  form: UseFormReturn<ProductFormValues>;
  aggregateRevision?: number;
  onAggregateRevisionChange?: (revision: number) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
  onProductSaved?: (values: ProductFormValues, aggregateRevision: number) => void;
  createComposition?: ProductCreateComposition | null;
  /** Marks a rejected variant/SKU field in the variant editor; returns its banner line. */
  onVariantIssue?: (path: string, message: string) => string | null;
}

interface ProductMutationVariables {
  values: ProductFormValues;
  acknowledgedSkuImageRemovalIds?: string[];
}

/** SKU conflicts name the product that owns the SKU (`SKU_TAKEN`, 409). */
export function readSkuTaken(error: unknown): { path: string; message: string } | null {
  if (!(error instanceof AdminApiResponseError) || error.code !== "SKU_TAKEN") return null;
  const details = error.details as { field?: string; sku?: string; productName?: string } | undefined;
  return {
    path: details?.field ?? "sku",
    message: t("skuTaken", { sku: details?.sku ?? "", product: details?.productName ?? "" }),
  };
}

/**
 * Saves the product fields (and, for a new product, its variants). `submit`
 * resolves with the new revision or rejects with the reasons, after putting
 * each server rejection on its field; the page's save bar shows the banner.
 */
export function useProductSubmit({
  isEdit,
  productId,
  form,
  aggregateRevision,
  onAggregateRevisionChange,
  onRevisionConflict,
  onProductSaved,
  createComposition,
  onVariantIssue,
}: UseProductSubmitOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mediaRemovalConflict, setMediaRemovalConflict] = useState<ProductMediaSkuReferenceConflict | null>(null);
  const [pendingValues, setPendingValues] = useState<ProductFormValues | null>(null);

  const mutation = useMutation({
    mutationFn: async ({ values, acknowledgedSkuImageRemovalIds }: ProductMutationVariables) => {
      const formattedValues = formatFormValuesForSubmission(values);
      if (isEdit) {
        const entityId = productId || values.id;
        if (!entityId || !aggregateRevision) throw new Error(t("saveFailed"));
        return apiData(putApiV1AdminProductsById({
          path: { id: entityId },
          body: {
            ...formattedValues,
            id: entityId,
            expectedAggregateRevision: aggregateRevision,
            ...(acknowledgedSkuImageRemovalIds ? { acknowledgedSkuImageRemovalIds } : {}),
          },
        }));
      }
      return apiData(postApiV1AdminProducts({ body: { ...formattedValues, ...createComposition } }));
    },
    onSuccess: async (result, { values }) => {
      setMediaRemovalConflict(null);
      setPendingValues(null);
      if (isEdit) {
        form.reset(form.getValues());
        onAggregateRevisionChange?.(result.aggregateRevision);
        onProductSaved?.(values, result.aggregateRevision);
      }
      const savedProductId: string | null = (isEdit ? productId || values.id : "id" in result ? String(result.id) : null) ?? null;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.products.list() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.byIds() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.collectionOptions() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.stats() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list() }),
        ...(savedProductId
          ? [
              queryClient.invalidateQueries({ queryKey: queryKeys.products.detail(savedProductId) }),
              queryClient.invalidateQueries({ queryKey: queryKeys.products.variants(savedProductId) }),
            ]
          : []),
      ]);
      if (!isEdit && savedProductId) {
        // The new product's page takes over; its fields are saved.
        form.reset(form.getValues());
        void navigate({ to: "/admin/products/$productId/edit", params: { productId: savedProductId } });
      }
    },
  });

  /** Turns a rejected save into field messages plus the banner's lines. */
  const explain = (error: unknown, values: ProductFormValues): never => {
    const conflict = readProductRevisionConflict(error);
    if (conflict) {
      onRevisionConflict?.(conflict);
      throw new SaveNotCompleted(t("changedElsewhere"));
    }
    const mediaConflict = readProductMediaSkuReferenceConflict(error);
    if (mediaConflict) {
      setPendingValues(values);
      setMediaRemovalConflict(mediaConflict);
      throw new SaveNotCompleted(t("removeVariantPhotosTitle", { count: mediaConflict.affectedCount }));
    }
    if (error instanceof AdminApiResponseError && error.status === 409 && /slug/i.test(error.message)) {
      form.setError("slug", { type: "server", message: t("slugTaken") });
      throw new SaveNotCompleted(t("slugTaken"), [`${t("webAddress")}: ${t("slugTaken")}`]);
    }
    const skuTaken = readSkuTaken(error);
    const issues = skuTaken ? [skuTaken] : readApiFieldIssues(error);
    if (issues) {
      const lines = issues.map(({ path, message }) => {
        const field = path.split(".")[0] as keyof ProductFormValues;
        if (field in FIELD_LABELS) {
          form.setError(field, { type: "server", message });
          return `${t(FIELD_LABELS[field]!)}: ${message}`;
        }
        return onVariantIssue?.(path, message) ?? message;
      });
      throw new SaveNotCompleted(lines[0], lines);
    }
    throw new SaveNotCompleted(getServerFnError(error, t("saveFailed")));
  };

  const submit = async (values: ProductFormValues): Promise<number> => {
    try {
      const result = await mutation.mutateAsync({ values });
      return result.aggregateRevision;
    } catch (error) {
      return explain(error, values);
    }
  };

  const confirmMediaRemoval = async () => {
    if (!pendingValues || !mediaRemovalConflict) return;
    try {
      await mutation.mutateAsync({
        values: pendingValues,
        acknowledgedSkuImageRemovalIds: mediaRemovalConflict.affectedAssociationIds,
      });
      toast.success(t("productSaved"));
    } catch (error) {
      try {
        explain(error, pendingValues);
      } catch (explained) {
        toast.error((explained as Error).message);
      }
    }
  };

  const cancelMediaRemoval = () => {
    setMediaRemovalConflict(null);
    setPendingValues(null);
  };

  return {
    isSubmitting: mutation.isPending,
    submit,
    mediaRemovalConflict,
    confirmMediaRemoval,
    cancelMediaRemoval,
  };
}
