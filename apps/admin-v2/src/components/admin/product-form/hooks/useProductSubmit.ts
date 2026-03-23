// src/components/admin/product-form/hooks/useProductSubmit.ts
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import type { ProductFormValues } from "../types";
import { formatFormValuesForSubmission } from "../utils";
import { useNavigate } from "@tanstack/react-router";
import { createProduct, updateProduct } from "~/lib/api.functions";
import { getServerFnError } from "@/lib/api-helpers";

interface UseProductSubmitOptions {
  isEdit: boolean;
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
  enableVariantImages,
  form,
  onSuccess,
}: UseProductSubmitOptions): UseProductSubmitReturn {
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");

  const handleSubmit = async (values: ProductFormValues) => {
    try {
      setIsSubmitting(true);
      const formattedValues = formatFormValuesForSubmission(
        values,
        enableVariantImages,
      );

      let result: Record<string, unknown>;
      if (isEdit) {
        result = await updateProduct({ data: { id: values.id!, ...formattedValues } }) as Record<string, unknown>;
      } else {
        result = await createProduct({ data: formattedValues as Record<string, unknown> }) as Record<string, unknown>;
      }

      toast.success("Success", { description: isEdit
          ? "Product updated successfully."
          : "Product created successfully." });

      // Reset form dirty state after successful save
      if (isEdit) {
        // For edits, reset the form to mark it as clean (not dirty)
        form.reset(form.getValues());
      }

      if (onSuccess) {
        onSuccess();
      } else if (!isEdit) {
        // For new products, redirect to edit page with the new product ID
        void navigate({ to: `/admin/products/${result.id}/edit` as string });
      }
    } catch (error: unknown) {
      console.error("Error submitting form:", error);
      const errorMessage = getServerFnError(error, "Failed to save product");
      if (errorMessage.includes("slug already exists")) {
        form.setError("slug", { type: "manual", message: "This slug is already in use. Please choose a different one." });
        setAlertMessage("This slug is already in use. Please choose a different one.");
        setShowAlert(true);
      } else {
        toast.error("Error", { description: errorMessage });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    isSubmitting,
    showAlert,
    alertMessage,
    setShowAlert,
    handleSubmit,
  };
}
