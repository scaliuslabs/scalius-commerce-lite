import type { UseFormReturn } from "react-hook-form";
import { useWatch } from "react-hook-form";
import { SearchListingCard, type SearchListingValue } from "~/components/admin/search-listing/SearchListingCard";
import { getPlainText } from "~/lib/format-utils";
import type { ProductFormValues } from "./types";

/** The product's "Search engine listing" card, bound to the product form. */
export function ProductSearchListing({ form, disabled }: { form: UseFormReturn<ProductFormValues>; disabled?: boolean }) {
  const [name, description, metaTitle, metaDescription, slug, noIndex, excludeFromProductFeed] = useWatch({
    control: form.control,
    name: ["name", "description", "metaTitle", "metaDescription", "slug", "noIndex", "excludeFromProductFeed"],
  });
  const { errors } = form.formState;

  const onChange = (next: Partial<SearchListingValue>) => {
    const options = { shouldDirty: true, shouldValidate: true } as const;
    if (next.title !== undefined) form.setValue("metaTitle", next.title || null, options);
    if (next.description !== undefined) form.setValue("metaDescription", next.description || null, options);
    if (next.handle !== undefined) {
      form.setValue("slug", next.handle, options);
      form.setValue("slugEdited", true);
    }
    if (next.hidden !== undefined) form.setValue("noIndex", next.hidden, options);
    if (next.excludeFromFeed !== undefined) form.setValue("excludeFromProductFeed", next.excludeFromFeed, options);
  };

  return (
    <SearchListingCard
      resource="product"
      value={{
        title: metaTitle ?? "",
        description: metaDescription ?? "",
        handle: slug ?? "",
        hidden: Boolean(noIndex),
        excludeFromFeed: Boolean(excludeFromProductFeed),
      }}
      onChange={onChange}
      fallbackTitle={name ?? ""}
      fallbackDescription={getPlainText(description ?? null, 320)}
      errors={{
        title: errors.metaTitle?.message,
        description: errors.metaDescription?.message,
        handle: errors.slug?.message,
      }}
      disabled={disabled}
    />
  );
}
