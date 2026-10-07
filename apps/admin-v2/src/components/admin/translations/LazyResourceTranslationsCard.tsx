import { lazy, Suspense } from "react";
import type { TranslationEditorType } from "~/lib/api-query-options/translations";

// The Translations card (its editor, rich text included) downloads after the
// page that shows it, so a resource page's first render does not wait for it.
const ResourceTranslationsCard = lazy(() => import("./ResourceTranslationsCard").then((module) => ({ default: module.ResourceTranslationsCard })));

/** A product's, collection's or category's text in the store's other languages. */
export function LazyResourceTranslationsCard(props: { type: TranslationEditorType; id: string }) {
  return (
    <Suspense fallback={null}>
      <ResourceTranslationsCard {...props} />
    </Suspense>
  );
}
