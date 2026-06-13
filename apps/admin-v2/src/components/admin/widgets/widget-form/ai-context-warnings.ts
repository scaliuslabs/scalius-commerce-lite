import { toast } from "sonner";
import type { AiContextBatchDetails } from "@/lib/api-functions/ai";

export type { AiContextBatchDetails };

export function notifyAiContextWarnings(contextData: AiContextBatchDetails) {
  const warnings = contextData.warnings;
  if (!warnings) return;

  if (warnings.productsTruncated && warnings.maxProducts) {
    toast.warning(`Using the first ${warnings.maxProducts} selected products for this AI request.`);
  }

  if (warnings.categoriesTruncated && warnings.maxCategories) {
    toast.warning(`Using up to ${warnings.maxCategories} categories for this AI request.`);
  }

  if (warnings.collectionsTruncated && warnings.maxCollections) {
    toast.warning(`Using up to ${warnings.maxCollections} collections for this AI request.`);
  }

  if (warnings.productsUnavailable) {
    toast.warning(
      `${warnings.productsUnavailable} selected product${warnings.productsUnavailable === 1 ? " was" : "s were"} skipped because ${warnings.productsUnavailable === 1 ? "it is" : "they are"} not storefront-visible.`,
    );
  }

  if (warnings.categoriesUnavailable) {
    toast.warning(
      `${warnings.categoriesUnavailable} selected categor${warnings.categoriesUnavailable === 1 ? "y was" : "ies were"} skipped because ${warnings.categoriesUnavailable === 1 ? "it is" : "they are"} deleted.`,
    );
  }

  if (warnings.collectionsUnavailable) {
    toast.warning(
      `${warnings.collectionsUnavailable} selected collection${warnings.collectionsUnavailable === 1 ? " was" : "s were"} skipped because ${warnings.collectionsUnavailable === 1 ? "it is" : "they are"} inactive or deleted.`,
    );
  }
}
