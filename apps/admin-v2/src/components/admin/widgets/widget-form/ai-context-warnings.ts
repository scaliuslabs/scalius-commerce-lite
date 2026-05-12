import { toast } from "sonner";

export interface AiContextBatchDetails {
  products?: unknown[];
  categories?: unknown[];
  warnings?: {
    productsTruncated?: boolean;
    categoriesTruncated?: boolean;
    maxProducts?: number;
    maxCategories?: number;
  };
}

export function notifyAiContextWarnings(contextData: AiContextBatchDetails) {
  const warnings = contextData.warnings;
  if (!warnings) return;

  if (warnings.productsTruncated && warnings.maxProducts) {
    toast.warning(`Using the first ${warnings.maxProducts} selected products for this AI request.`);
  }

  if (warnings.categoriesTruncated && warnings.maxCategories) {
    toast.warning(`Using up to ${warnings.maxCategories} categories for this AI request.`);
  }
}
