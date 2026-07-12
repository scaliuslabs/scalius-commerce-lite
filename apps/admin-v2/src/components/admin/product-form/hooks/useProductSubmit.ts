// src/components/admin/product-form/hooks/useProductSubmit.ts
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProductFormValues } from "../types";
import { formatFormValuesForSubmission } from "../utils";
import { useNavigate } from "@tanstack/react-router";
import { createProduct, updateProduct } from "~/lib/api-functions/products";
import { getServerFnError } from "~/lib/api-helpers";
import {
  readProductRevisionConflict,
  type ProductRevisionConflict,
} from "~/lib/admin-api-error";
import type { ProductOptionMatrixInput } from "~/lib/api-functions/products";

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
  optionMatrixDraft?: Omit<ProductOptionMatrixInput, "expectedAggregateRevision"> | null;
  optionMatrixIssue?: string | null;
}

interface UseProductSubmitReturn {
  isSubmitting: boolean;
  showAlert: boolean;
  alertMessage: string;
  setShowAlert: (show: boolean) => void;
  handleSubmit: (values: ProductFormValues) => Promise<boolean>;
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
  optionMatrixDraft,
  optionMatrixIssue = null,
}: UseProductSubmitOptions): UseProductSubmitReturn {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");

  const mutation = useMutation({
    mutationFn: async (values: ProductFormValues) => {
      const formattedValues = formatFormValuesForSubmission(values);
      if (isEdit) {
        const entityId = productId || values.id;
        if (!entityId) throw new Error("Product ID is required for update");
        if (!aggregateRevision) {
          throw new Error("Product revision is required for update");
        }
        return updateProduct({
          data: {
            ...formattedValues,
            id: entityId,
            expectedAggregateRevision: aggregateRevision,
          },
        });
      }
      return createProduct({
        data: {
          ...formattedValues,
          ...(optionMatrixDraft ? { optionMatrix: optionMatrixDraft } : {}),
        },
      });
    },
    onSuccess: (result, values) => {
      toast.success("Success", {
        description: isEdit
          ? "Product updated successfully."
          : "Product created successfully.",
      });

      // Reset form dirty state after successful save
      if (isEdit) {
        form.reset(form.getValues());
        onAggregateRevisionChange?.(result.aggregateRevision);
        onProductSaved?.(values, result.aggregateRevision);
      }

      // Invalidate product queries so lists/details refetch
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["categories", "form-options"] });

      if (onSuccess) {
        onSuccess();
      } else if (!isEdit) {
        const createdProductId =
          "id" in result && typeof result.id === "string" ? result.id : null;
        if (!createdProductId) {
          toast.error("Error", {
            description: "Product was created but no product ID was returned.",
          });
          return;
        }
        void navigate({
          to: "/admin/products/$productId/edit",
          params: { productId: createdProductId },
        });
      }
    },
    onError: (error: unknown) => {
      const conflict = readProductRevisionConflict(error);
      if (conflict) {
        onRevisionConflict?.(conflict);
        return;
      }
      const errorMessage = getServerFnError(error, "Failed to save product");
      if (errorMessage.includes("slug already exists")) {
        form.setError("slug", {
          type: "manual",
          message:
            "This slug is already in use. Please choose a different one.",
        });
        setAlertMessage(
          "This slug is already in use. Please choose a different one.",
        );
        setShowAlert(true);
      } else {
        toast.error("Error", { description: errorMessage });
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
      await mutation.mutateAsync(values);
      return true;
    } catch {
      // React Query has already run the mutation's onError handler, so keep the
      // existing toast and field errors as the authoritative failure feedback.
      return false;
    }
  };

  return {
    isSubmitting: mutation.isPending,
    showAlert,
    alertMessage,
    setShowAlert,
    handleSubmit,
  };
}
