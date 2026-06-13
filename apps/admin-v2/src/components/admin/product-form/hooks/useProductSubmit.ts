// src/components/admin/product-form/hooks/useProductSubmit.ts
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProductFormValues } from "../types";
import { formatFormValuesForSubmission } from "../utils";
import { useNavigate } from "@tanstack/react-router";
import { createProduct, updateProduct } from "~/lib/api-functions/products";
import { getServerFnError } from "@/lib/api-helpers";

interface UseProductSubmitOptions {
  isEdit: boolean;
  productId?: string;
  enableVariantImages: boolean;
  form: UseFormReturn<ProductFormValues>;
  onSuccess?: () => void;
}

interface UseProductSubmitReturn {
  isSubmitting: boolean;
  showAlert: boolean;
  alertMessage: string;
  setShowAlert: (show: boolean) => void;
  handleSubmit: (values: ProductFormValues) => Promise<void>;
}

export function useProductSubmit({
  isEdit,
  productId,
  enableVariantImages,
  form,
  onSuccess,
}: UseProductSubmitOptions): UseProductSubmitReturn {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");

  const mutation = useMutation({
    mutationFn: async (values: ProductFormValues) => {
      const formattedValues = formatFormValuesForSubmission(
        values,
        enableVariantImages,
      );
      if (isEdit) {
        const entityId = productId || values.id;
        if (!entityId) throw new Error("Product ID is required for update");
        return updateProduct({ data: { ...formattedValues, id: entityId } });
      }
      return createProduct({ data: formattedValues });
    },
    onSuccess: (result) => {
      toast.success("Success", {
        description: isEdit
          ? "Product updated successfully."
          : "Product created successfully.",
      });

      // Reset form dirty state after successful save
      if (isEdit) {
        form.reset(form.getValues());
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
    mutation.mutate(values);
  };

  return {
    isSubmitting: mutation.isPending,
    showAlert,
    alertMessage,
    setShowAlert,
    handleSubmit,
  };
}
