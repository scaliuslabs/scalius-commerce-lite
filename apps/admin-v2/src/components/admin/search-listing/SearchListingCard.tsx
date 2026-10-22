import { useId, useState } from "react";
import { Pencil } from "lucide-react";
import { autoHandleFor } from "./auto-handle";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { useMessages } from "~/i18n";
import { searchListingMessages } from "~/i18n/search-listing";
import { Field, ReadOnlyValue } from "~/components/ui/field";

/** Recommended lengths; search engines cut longer text. */
export const SEARCH_TITLE_LENGTH = 70;
export const SEARCH_DESCRIPTION_LENGTH = 160;

export type SearchListingResource = "product" | "collection" | "category" | "brand" | "page" | "blogPost";

const PATH_PREFIX: Record<SearchListingResource, string> = {
  product: "/products/",
  collection: "/collections/",
  category: "/categories/",
  brand: "/brands/",
  page: "/",
  blogPost: "/blog/",
};

export interface SearchListingValue {
  /** Search title; empty means the resource name is used. */
  title: string;
  /** Search description; empty means the resource's own text is used. */
  description: string;
  /** URL handle (slug). Leave undefined for resources addressed by id. */
  handle?: string;
  /** Hide from search engines: the page stays public (noindex,follow). */
  hidden: boolean;
}

export interface SearchListingCardProps {
  resource: SearchListingResource;
  value: SearchListingValue;
  onChange: (next: Partial<SearchListingValue>) => void;
  /** The resource name, shown when the search title is empty. */
  fallbackTitle: string;
  /** Plain text shown when the search description is empty. */
  fallbackDescription?: string;
  /** Storefront path when the resource has no handle, e.g. `/collections/<id>`; null until it is saved. */
  path?: string | null;
  /**
   * New items whose handle the merchant hasn't typed: the handle the server
   * makes from the name (`@scalius/shared/handle`), shown while the field is
   * empty. The server adds a number when it is taken.
   */
  autoHandle?: string;
  /** Inline field errors from the form (already translated). */
  errors?: Partial<Record<"title" | "description" | "handle", string>>;
  /** Permission-limited display: show readable facts and unmount every editor control. */
  disabled?: boolean;
  /** The saved handle changed: whether the old address redirects to the new one. */
  redirect?: { fromHandle: string; checked: boolean; onChange: (checked: boolean) => void };
}

export { autoHandleFor };

/** Google-style result: address, title, description. */
export function SearchListingPreview({
  url,
  title,
  description,
}: {
  url: string;
  title: string;
  description: string;
}) {
  return (
    <div className="min-w-0 space-y-1" aria-live="polite">
      <p title={url} className="truncate text-body text-muted-foreground">{url}</p>
      <p className="line-clamp-2 text-heading-md text-link">{title}</p>
      {description ? (
        <p className="line-clamp-2 text-body text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

/**
 * Shopify's "Search engine listing" card, shared by products, collections,
 * categories and pages. The form owns the values; this card only edits them.
 */
export function SearchListingCard({
  resource,
  value,
  onChange,
  fallbackTitle,
  fallbackDescription = "",
  path,
  autoHandle,
  errors = {},
  disabled = false,
  redirect,
}: SearchListingCardProps) {
  const t = useMessages(searchListingMessages);
  const id = useId();
  const [editing, setEditing] = useState(false);
  const { storefrontUrl } = useStorefrontUrl();
  const origin = (storefrontUrl ?? "").replace(/\/+$/, "");
  const prefix = PATH_PREFIX[resource];
  const handle = value.handle || autoHandle || "";
  const shownUrl = path === null ? t("addressOnSave") : `${origin}${path ?? `${prefix}${handle}`}`;
  const title = value.title.trim() || fallbackTitle.trim();
  const description = (value.description.trim() || fallbackDescription.trim()).slice(0, 320);
  const open = !disabled && (editing || Object.values(errors).some(Boolean));

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 p-4">
        <h2 className="text-heading-sm">{t("title")}</h2>
        {disabled ? null : <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("edit")}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setEditing((current) => !current)}
        >
          <Pencil className="size-4" />
        </Button>}
      </div>
      <div className="space-y-4 px-4 pb-4">
        {disabled ? (
          <div className="space-y-3">
            <ReadOnlyValue label={t("pageTitle")} value={title} />
            <ReadOnlyValue label={t("metaDescription")} value={value.description.trim() || fallbackDescription.trim()} />
            <ReadOnlyValue label={t("urlHandle")} value={shownUrl} />
          </div>
        ) : title ? (
          <SearchListingPreview url={shownUrl} title={title} description={description} />
        ) : (
          <p className="text-body text-muted-foreground">{t(`empty_${resource}`)}</p>
        )}
        {value.hidden ? <p className="text-body text-muted-foreground">{t("hiddenNote")}</p> : null}

        {open ? (
          <div className="space-y-4 border-t pt-4">
            <Field id={`${id}-title`} label={t("pageTitle")} help={t("charactersUsed", { count: value.title.length, limit: SEARCH_TITLE_LENGTH })} error={errors.title}>
              <Input
                id={`${id}-title`}
                value={value.title}
                placeholder={fallbackTitle}
                disabled={disabled}
                onChange={(event) => onChange({ title: event.target.value })}
              />
            </Field>
            <Field id={`${id}-description`} label={t("metaDescription")} help={t("charactersUsed", { count: value.description.length, limit: SEARCH_DESCRIPTION_LENGTH })} error={errors.description}>
              <Textarea
                id={`${id}-description`}
                value={value.description}
                disabled={disabled}
                onChange={(event) => onChange({ description: event.target.value })}
                rows={3}
              />
            </Field>
            {value.handle !== undefined ? (
              <Field
                id={`${id}-handle`}
                label={t("urlHandle")}
                error={errors.handle}
                help={<>
                  <span className="block truncate" title={`${origin}${prefix}${handle}`}>{`${origin}${prefix}${handle}`}</span>
                  {autoHandle !== undefined ? <span className="block">{t("autoHandleHint")}</span> : null}
                </>}
              >
                <Input
                  id={`${id}-handle`}
                  value={value.handle}
                  placeholder={autoHandle}
                  disabled={disabled}
                  inputMode="url"
                  autoCapitalize="none"
                  onChange={(event) => onChange({ handle: event.target.value })}
                />
              </Field>
            ) : null}
            {redirect && !disabled ? (
              <label className="flex items-start gap-3 text-body">
                <Checkbox
                  checked={redirect.checked}
                  onCheckedChange={(checked) => redirect.onChange(checked === true)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  {t("redirectOld")}
                  <span className="block truncate text-muted-foreground" title={`${prefix}${redirect.fromHandle} → ${prefix}${handle}`}>
                    <code>{`${prefix}${redirect.fromHandle}`}</code>{" → "}<code>{`${prefix}${handle}`}</code>
                  </span>
                </span>
              </label>
            ) : null}
            <label className="flex items-start gap-3 text-body">
              <Checkbox
                checked={value.hidden}
                disabled={disabled}
                onCheckedChange={(checked) => onChange({ hidden: checked === true })}
                className="mt-0.5"
              />
              <span>
                {t("hide")}
                <span className="block text-muted-foreground">{t("hideHelp")}</span>
              </span>
            </label>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
