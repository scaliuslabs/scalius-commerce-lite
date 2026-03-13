// src/components/admin/product-form/ProductFormActions.tsx
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface ProductFormActionsProps {
  isEdit: boolean;
  isSubmitting: boolean;
  cancelUrl?: string;
}

export function ProductFormActions({
  isEdit,
  isSubmitting,
  cancelUrl = "/admin/products",
}: ProductFormActionsProps) {
  return (
    <div className="flex justify-end space-x-4">
      <Button variant="outline" type="button" asChild>
        <a href={cancelUrl}>Cancel</a>
      </Button>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {isEdit ? "Update Product" : "Create Product"}
      </Button>
    </div>
  );
}
