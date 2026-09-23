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
import {
  readProductMediaSkuReferenceConflict,
  readProductRevisionConflict,
  type ProductMediaSkuReferenceConflict,
  type ProductRevisionConflict,
} from "~/lib/admin-api-error";
import type { ProductCreateComposition } from "../variants/option-matrix-editor-model";
import { queryKeys } from "~/lib/query-keys";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";

interface UseProductSubmitOptions {
  isEdit: boolean;
  productId?: string;
  form: UseFormReturn<ProductFormValues>;
  aggregateRevision?: number;
  revisionConflict?: ProductRevisionConflict | null;
  onAggregateRevisionChange?: (revision: number) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
  onOpenRevisionConflict?: () => void;
  onProductSaved?: (values: ProductFormValues, aggregateRevision: number) => void;
  onSuccess?: () => void;
  createComposition?: ProductCreateComposition | null;
  optionMatrixIssue?: string | null;
}

interface UseProductSubmitReturn {
  isSubmitting: boolean;
  showAlert: boolean;
  alertMessage: string;
  setShowAlert: (show: boolean) => void;
  handleSubmit: (values: ProductFormValues) => Promise<boolean>;
  mediaRemovalConflict: ProductMediaSkuReferenceConflict | null;
  confirmMediaRemoval: () => Promise<boolean>;
  cancelMediaRemoval: () => void;
}

interface ProductMutationVariables {
  values: ProductFormValues;
  acknowledgedSkuImageRemovalIds?: string[];
}

export function useProductSubmit({
  isEdit,
  productId,
  form,
  aggregateRevision,
  revisionConflict = null,
  onAggregateRevisionChange,
  onRevisionConflict,
  onOpenRevisionConflict,
  onProductSaved,
  onSuccess,
  createComposition,
  optionMatrixIssue = null,
}: UseProductSubmitOptions): UseProductSubmitReturn {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");
  const [mediaRemovalConflict, setMediaRemovalConflict] = useState<ProductMediaSkuReferenceConflict | null>(null);
  const [pendingValues, setPendingValues] = useState<ProductFormValues | null>(null);

  const mutation = useMutation({
    mutationFn: async ({ values, acknowledgedSkuImageRemovalIds }: ProductMutationVariables) => {
      const formattedValues = formatFormValuesForSubmission(values);
      if (isEdit) {
        const entityId = productId || values.id;
        if (!entityId) throw new Error("Product ID is required for update");
        if (!aggregateRevision) {
          throw new Error("Product revision is required for update");
        }
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
      return apiData(postApiV1AdminProducts({
        body: {
          ...formattedValues,
          ...createComposition,
        },
      }));
    },
    onSuccess: async (result, { values }) => {
      setMediaRemovalConflict(null);
      setPendingValues(null);

      // Reset form dirty state after successful save
      if (isEdit) {
        form.reset(form.getValues());
        onAggregateRevisionChange?.(result.aggregateRevision);
        onProductSaved?.(values, result.aggregateRevision);
      }

      const savedProductId = isEdit
        ? productId || values.id
        : "id" in result && typeof result.id === "string"
          ? result.id
          : null;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.products.list() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.byIds() }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.products.collectionOptions(),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.stats() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list() }),
        ...(savedProductId
          ? [
              queryClient.invalidateQueries({
                queryKey: queryKeys.products.detail(savedProductId),
              }),
              queryClient.invalidateQueries({
                queryKey: queryKeys.products.variants(savedProductId),
              }),
            ]
          : []),
      ]);
      toast.success(translate(productMessages, isEdit ? "productSaved" : "productAdded"));

      if (onSuccess) {
        onSuccess();
      } else if (!isEdit) {
        if (!savedProductId) {
          toast.error(translate(productMessages, "addedWithoutId"));
          return;
        }
        void navigate({
          to: "/admin/products/$productId/edit",
          params: { productId: savedProductId },
        });
      }
    },
    onError: (error: unknown, { values }: ProductMutationVariables) => {
      const conflict = readProductRevisionConflict(error);
      if (conflict) {
        setMediaRemovalConflict(null);
        setPendingValues(null);
        onRevisionConflict?.(conflict);
        return;
      }
      const mediaConflict = readProductMediaSkuReferenceConflict(error);
      if (mediaConflict) {
        setPendingValues(values);
        setMediaRemovalConflict(mediaConflict);
        return;
      }
      const errorMessage = getServerFnError(error, translate(productMessages, "saveFailed"));
      if (errorMessage.includes("slug already exists")) {
        const slugTaken = translate(productMessages, "slugTaken");
        form.setError("slug", { type: "manual", message: slugTaken });
        setAlertMessage(slugTaken);
        setShowAlert(true);
      } else {
        toast.error(errorMessage);
      }
    },
  });

  const handleSubmit = async (values: ProductFormValues) => {
    if (revisionConflict) {
      onOpenRevisionConflict?.();
      return false;
    }
    if (optionMatrixIssue) {
      setAlertMessage(optionMatrixIssue);
      setShowAlert(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-option-matrix]")?.focus());
      return false;
    }
    try {
      await mutation.mutateAsync({ values });
      return true;
    } catch {
      // React Query has already run the mutation's onError handler, so keep the
      // existing toast and field errors as the authoritative failure feedback.
      return false;
    }
  };

  const confirmMediaRemoval = async () => {
    if (!pendingValues || !mediaRemovalConflict) return false;
    try {
      await mutation.mutateAsync({
        values: pendingValues,
        acknowledgedSkuImageRemovalIds: mediaRemovalConflict.affectedAssociationIds,
      });
      return true;
    } catch {
      return false;
    }
  };

  const cancelMediaRemoval = () => {
    setMediaRemovalConflict(null);
    setPendingValues(null);
  };

  return {
    isSubmitting: mutation.isPending,
    showAlert,
    alertMessage,
    setShowAlert,
    handleSubmit,
    mediaRemovalConflict,
    confirmMediaRemoval,
    cancelMediaRemoval,
  };
}
