// src/components/admin/product-form/hooks/useProductSubmit.ts
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import type { ProductFormValues } from "../types";
import { formatFormValuesForSubmission } from "../utils";
import { navigateTo } from "@/lib/client/navigate";
import { extractApiError, extractApiErrorDetails, unwrapEnvelope } from "@/lib/api-helpers";

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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState("");

  const handleSubmit = async (values: ProductFormValues) => {
    try {
      setIsSubmitting(true);
      const endpoint = isEdit ? `/api/v1/admin/products/${values.id}` : "/api/v1/admin/products";
      const method = isEdit ? "PUT" : "POST";

      const formattedValues = formatFormValuesForSubmission(
        values,
        enableVariantImages,
      );

      const response = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(formattedValues),
      });

      const data = await response.json();

      if (!response.ok) {
        const errorMessage = extractApiError(data, "Failed to save product");
        if (errorMessage === "A product with this slug already exists") {
          // Set error on the slug field
          form.setError("slug", {
            type: "manual",
            message:
              "This slug is already in use. Please choose a different one.",
          });

          // Show alert dialog
          setAlertMessage(
            "This slug is already in use. Please choose a different one.",
          );
          setShowAlert(true);
        } else {
          const details = extractApiErrorDetails(data);
          if (details) {
            // Handle Zod validation errors
            details.forEach((error: { path?: string[]; message?: string }) => {
              if (error.path && error.path.length > 0) {
                const fieldName = error.path[0] as keyof ProductFormValues;
                form.setError(fieldName, {
                  type: "manual",
                  message: error.message,
                });
              }
            });
            toast.error("Validation Error", { description: "Please check the form for errors." });
          } else {
            toast.error("Error", { description: errorMessage });
          }
        }
        throw new Error(errorMessage);
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
        const result = unwrapEnvelope(data);
        await navigateTo(`/admin/products/${result.id}/edit?new=true`);
      }
    } catch (error: unknown) {
      console.error("Error submitting form:", error);
      // Don't show a generic alert as we're using toast notifications and alert dialog
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
