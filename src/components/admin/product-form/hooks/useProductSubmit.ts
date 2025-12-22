// src/components/admin/product-form/hooks/useProductSubmit.ts
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useToast } from "@/hooks/use-toast";
import type { ProductFormValues } from "../types";
import { formatFormValuesForSubmission } from "../utils";

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
  const { toast } = useToast();

  const handleSubmit = async (values: ProductFormValues) => {
    try {
      setIsSubmitting(true);
      const endpoint = isEdit ? `/api/products/${values.id}` : "/api/products";
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
        if (data.error === "A product with this slug already exists") {
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
        } else if (data.details && Array.isArray(data.details)) {
          // Handle Zod validation errors
          data.details.forEach((error: any) => {
            if (error.path && error.path.length > 0) {
              const fieldName = error.path[0] as keyof ProductFormValues;
              form.setError(fieldName, {
                type: "manual",
                message: error.message,
              });
            }
          });
          toast({
            variant: "destructive",
            title: "Validation Error",
            description: "Please check the form for errors.",
          });
        } else {
          toast({
            variant: "destructive",
            title: "Error",
            description:
              data.error || "Failed to save product. Please try again.",
          });
        }
        throw new Error(data.error || "Failed to save product");
      }

      toast({
        title: "Success",
        description: isEdit
          ? "Product updated successfully."
          : "Product created successfully.",
      });

      // Reset form dirty state after successful save
      if (isEdit) {
        // For edits, reset the form to mark it as clean (not dirty)
        form.reset(form.getValues());
      }

      if (onSuccess) {
        onSuccess();
      } else if (!isEdit) {
        // For new products, redirect to edit page with the new product ID
        window.location.href = `/admin/products/${data.id}/edit?new=true`;
      }
    } catch (error) {
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
