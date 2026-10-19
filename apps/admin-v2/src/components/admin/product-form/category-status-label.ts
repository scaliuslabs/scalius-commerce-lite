import type { useMessages } from "~/i18n";
import type { productMessages } from "~/i18n/products";
import type { Category } from "./types";

/** The note after a category's name when buyers can't browse it yet (draft) or at all (internal). */
export function categoryStatusLabel(t: ReturnType<typeof useMessages<keyof typeof productMessages.en>>, category: Category) {
  return category.status === "draft" ? t("statusDraft") : category.status === "internal" ? t("categoryHidden") : null;
}
