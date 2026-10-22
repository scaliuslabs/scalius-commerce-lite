import type { UseFormReturn } from "react-hook-form";
import { useWatch } from "react-hook-form";
import { SearchListingCard, autoHandleFor, type SearchListingValue } from "~/components/admin/search-listing/SearchListingCard";
import { getPlainText } from "~/lib/format-utils";
import type { ProductFormValues } from "./types";

/** The product's "Search engine listing" card, bound to the product form. */
export function ProductSearchListing({ form, disabled }: { form: UseFormReturn<ProductFormValues>; disabled?: boolean }) {
  const current = useWatch({
    control: form.control,
    name: ["id", "name", "description", "metaTitle", "metaDescription", "slug", "slugEdited", "noIndex"],
  });
  const keepOldAddress = useWatch({ control: form.control, name: "keepOldAddress" });
  const { errors, defaultValues } = form.formState;
  const [id, name, description, metaTitle, metaDescription, slug, slugEdited, noIndex] = disabled
    ? [defaultValues?.id, defaultValues?.name, defaultValues?.description, defaultValues?.metaTitle, defaultValues?.metaDescription, defaultValues?.slug, defaultValues?.slugEdited, defaultValues?.noIndex] as const
    : current;
  // A new product's address is made from its title on the server unless the merchant types one.
  const autoHandle = !id && (!slugEdited || !slug) ? autoHandleFor(name ?? "", "product") : undefined;

  const onChange = (next: Partial<SearchListingValue>) => {
    if (disabled) return;
    const options = { shouldDirty: true, shouldValidate: true } as const;
    if (next.title !== undefined) form.setValue("metaTitle", next.title || null, options);
    if (next.description !== undefined) form.setValue("metaDescription", next.description || null, options);
    if (next.handle !== undefined) {
      form.setValue("slug", next.handle, options);
      form.setValue("slugEdited", true);
    }
    if (next.hidden !== undefined) form.setValue("noIndex", next.hidden, options);
  };

  return (
    <SearchListingCard
      resource="product"
      value={{
        title: metaTitle ?? "",
        description: metaDescription ?? "",
        handle: slug ?? "",
        hidden: Boolean(noIndex),
      }}
      onChange={onChange}
      fallbackTitle={name ?? ""}
      fallbackDescription={getPlainText(description ?? null, 320)}
      autoHandle={autoHandle}
      errors={{
        title: errors.metaTitle?.message,
        description: errors.metaDescription?.message,
        handle: errors.slug?.message,
      }}
      disabled={disabled}
      // A saved product's new handle: offer to keep the old address working (on by default).
      redirect={id && defaultValues?.slug && slug && slug !== defaultValues.slug ? {
        fromHandle: defaultValues.slug,
        checked: keepOldAddress !== false,
        onChange: (checked) => form.setValue("keepOldAddress", checked),
      } : undefined}
    />
  );
}
