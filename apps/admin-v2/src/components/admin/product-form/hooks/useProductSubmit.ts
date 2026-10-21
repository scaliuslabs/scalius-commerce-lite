// src/components/admin/product-form/hooks/useProductSubmit.ts
import { useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "~/lib/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProductFormValues } from "../types";
import { formatFormValuesForSubmission, problemLine, productSubmitChanges } from "../utils";
import { useNavigate } from "@tanstack/react-router";
import {
  postApiV1AdminProducts,
  putApiV1AdminProductsById,
} from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";
import { saveProductChannels, salesChannelKeys } from "~/lib/api-query-options/sales-channels";
import { getServerFnError } from "~/lib/api-helpers";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { readProductMediaSkuReferenceConflict, readProductRevisionConflict, type ProductMediaSkuReferenceConflict, type ProductRevisionConflict } from "~/lib/admin-api-conflicts";
import { SaveNotCompleted, copyValues, rebaseForm } from "../../shared/use-form-save-bar";
import type { ProductCreateComposition, ProductUpdateComposition } from "../variants/option-matrix-editor-model";
import type { ProductSectionChanges } from "../merchandising/product-sections";
import type { UpdateProductInput } from "~/lib/api-query-options/products";
import { useSkuCosts } from "../sku-costs";
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
  isGiftCard: "giftCardProduct",
  warrantyPolicyId: "warranty",
  brandId: "brand",
};

interface UseProductSubmitOptions {
  isEdit: boolean;
  productId?: string;
  form: UseFormReturn<ProductFormValues>;
  aggregateRevision?: number;
  onAggregateRevisionChange?: (revision: number) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
  /**
   * Merges the draft onto the other save (three-way, lib/three-way-merge.ts)
   * and returns the revision to save at, or null when it could not (a real
   * clash the merchant left open, a deleted product). The save then retries once.
   */
  resolveRevisionConflict?: (conflict: ProductRevisionConflict) => Promise<number | null>;
  onProductSaved?: (values: ProductFormValues, aggregateRevision: number) => void;
  createComposition?: ProductCreateComposition | null;
  /** Marks a rejected variant/SKU field in the variant editor; returns its banner line. */
  onVariantIssue?: (path: string, message: string) => string | null;
  /** After a save that carried the variant draft: the editor settles it and sends typed costs. */
  onCompositionSaved?: (aggregateRevision: number) => Promise<void> | void;
}

interface ProductMutationVariables {
  values: ProductFormValues;
  acknowledgedSkuImageRemovalIds?: string[];
  /** The revision to save against when sections saved first in this save; the page's otherwise. */
  expectedAggregateRevision?: number;
  /** Everything else this Save changed: it goes in the same write, so all of it saves or none. */
  composition?: ProductSaveParts | null;
}

/** What a product Save sends besides its fields: the variant draft and the page's sections (costs are added here). */
export type ProductSaveParts = ProductUpdateComposition & ProductSectionChanges & Pick<UpdateProductInput, "skuCosts">;

/** SKU conflicts name the product that owns the SKU (`sku_taken`, 409). */
export function readSkuTaken(error: unknown): { path: string; message: string } | null {
  if (!(error instanceof AdminApiResponseError) || error.code !== "sku_taken") return null;
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
  resolveRevisionConflict,
  onProductSaved,
  createComposition,
  onVariantIssue,
  onCompositionSaved,
}: UseProductSubmitOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The page's typed costs: they go in the product's own write.
  const costs = useSkuCosts();
  const [mediaRemovalConflict, setMediaRemovalConflict] = useState<ProductMediaSkuReferenceConflict | null>(null);
  const [pendingValues, setPendingValues] = useState<ProductFormValues | null>(null);
  // What else the save that the photo-removal question paused carried, sent again with it.
  const pendingComposition = useRef<ProductSaveParts | null>(null);
  // The form as the save sent it: it becomes the saved values, and edits typed meanwhile stay unsaved.
  const sent = useRef<ProductFormValues | null>(null);
  const markSaved = () => {
    if (sent.current) rebaseForm(form, sent.current, sent.current);
  };

  const mutation = useMutation({
    mutationFn: async ({ values, acknowledgedSkuImageRemovalIds, expectedAggregateRevision, composition }: ProductMutationVariables) => {
      const dirty = form.formState.dirtyFields;
      const formattedValues = formatFormValuesForSubmission(values, isEdit ? productSubmitChanges(dirty) : undefined);
      if (isEdit) {
        const entityId = productId || values.id;
        const expected = expectedAggregateRevision ?? aggregateRevision;
        if (!entityId || !expected) throw new Error(t("saveFailed"));
        // The Publishing card saves first: it is not under the product's revision,
        // so a refused product write can be retried without a conflict.
        if (dirty.salesChannelIds && values.salesChannelIds) await saveProductChannels(entityId, values.salesChannelIds);
        return apiData(putApiV1AdminProductsById({
          path: { id: entityId },
          body: {
            ...formattedValues,
            id: entityId,
            expectedAggregateRevision: expected,
            ...(acknowledgedSkuImageRemovalIds ? { acknowledgedSkuImageRemovalIds } : {}),
            ...composition,
          },
        }));
      }
      // Only an address the merchant typed is sent; otherwise the server makes one from the title.
      const slug = values.slugEdited && values.slug ? values.slug : undefined;
      // Typed costs per item go with the new SKUs, in the same create.
      // Unticked channels go with the new product; untouched, it is on every channel.
      const salesChannelIds = values.salesChannelIds ?? undefined;
      return apiData(postApiV1AdminProducts({ body: { ...formattedValues, slug, salesChannelIds, ...withCreateCosts(createComposition) } }));
    },
    onSuccess: async (result, { values }) => {
      setMediaRemovalConflict(null);
      setPendingValues(null);
      if (isEdit) {
        markSaved();
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
        // Per-channel product counts.
        queryClient.invalidateQueries({ queryKey: salesChannelKeys.list() }),
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
        markSaved();
        void navigate({ to: "/admin/products/$productId/edit", params: { productId: savedProductId } });
      }
    },
  });

  /** A new product's SKUs with the costs typed for them (by the simple SKU's key, or each variant's draft id). */
  const withCreateCosts = (composition: ProductCreateComposition | null | undefined): ProductCreateComposition => {
    if (!composition) return {};
    if (!costs) return composition;
    if (composition.defaultSku) {
      const cost = costs.costOf(costs.simpleKey);
      return cost === null ? composition : { ...composition, defaultSku: { ...composition.defaultSku, cost } };
    }
    if (!composition.optionMatrix) return composition;
    return {
      ...composition,
      optionMatrix: {
        ...composition.optionMatrix,
        variants: composition.optionMatrix.variants.map((variant) => {
          const cost = costs.costOf(variant.id);
          return cost === null ? variant : { ...variant, cost };
        }),
      },
    };
  };

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
          return problemLine(t(FIELD_LABELS[field]!), message);
        }
        return onVariantIssue?.(path, message) ?? message;
      });
      throw new SaveNotCompleted(lines[0], lines);
    }
    throw new SaveNotCompleted(getServerFnError(error, t("saveFailed")));
  };

  const submit = async (
    values: ProductFormValues,
    expectedAggregateRevision?: number,
    parts: ProductSaveParts | null = null,
  ): Promise<number> => {
    // Changed costs per item go in the same write (a new product's go with its SKUs).
    const skuCosts = (isEdit ? costs?.changes() ?? [] : []).map((item) => ({ ...item, expectedCost: item.expectedCost ?? null }));
    const composition: ProductSaveParts | null = skuCosts.length > 0 ? { ...parts, skuCosts } : parts;
    let revision: number;
    try {
      sent.current = copyValues(form.getValues());
      pendingComposition.current = composition;
      revision = (await mutation.mutateAsync({ values, expectedAggregateRevision, composition })).aggregateRevision;
    } catch (error) {
      const conflict = isEdit && resolveRevisionConflict ? readProductRevisionConflict(error) : null;
      if (!conflict || !resolveRevisionConflict) return explain(error, values);
      // Someone saved first: combine the two saves and try once more at their revision.
      const next = await resolveRevisionConflict(conflict).catch(() => null);
      if (next === null) throw new SaveNotCompleted(t("changedElsewhere"));
      try {
        const merged = form.getValues();
        sent.current = copyValues(merged);
        revision = (await mutation.mutateAsync({ values: merged, expectedAggregateRevision: next, composition })).aggregateRevision;
      } catch (retryError) {
        return explain(retryError, values);
      }
      void import("~/lib/merge-document").then(({ mergedMessage }) => toast.success(mergedMessage()));
    }
    await afterPartsSaved(composition, revision);
    return revision;
  };

  /** After the write: the costs it sent are saved, then the variant editor settles its draft. */
  const afterPartsSaved = async (composition: ProductSaveParts | null, revision: number) => {
    const entityId = productId ?? "";
    if (composition?.skuCosts?.length && costs) costs.settle(composition.skuCosts, entityId);
    if (composition?.optionMatrix || composition?.defaultSku) await onCompositionSaved?.(revision);
  };

  const confirmMediaRemoval = async () => {
    if (!pendingValues || !mediaRemovalConflict) return;
    try {
      sent.current = copyValues(form.getValues());
      const composition = pendingComposition.current;
      const result = await mutation.mutateAsync({
        values: pendingValues,
        acknowledgedSkuImageRemovalIds: mediaRemovalConflict.affectedAssociationIds,
        composition,
      });
      await afterPartsSaved(composition, result.aggregateRevision);
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
