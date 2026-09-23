import { useId, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { useMessages } from "~/i18n";
import { searchListingMessages } from "~/i18n/search-listing";

/** Recommended lengths; search engines cut longer text. */
export const SEARCH_TITLE_LENGTH = 70;
export const SEARCH_DESCRIPTION_LENGTH = 160;

export type SearchListingResource = "product" | "collection" | "category" | "page" | "blogPost";

const PATH_PREFIX: Record<SearchListingResource, string> = {
  product: "/products/",
  collection: "/collections/",
  category: "/categories/",
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
  /** Products only: keep it out of the Facebook and Google product feeds. */
  excludeFromFeed?: boolean;
}

export interface SearchListingCardProps {
  resource: SearchListingResource;
  value: SearchListingValue;
  onChange: (next: Partial<SearchListingValue>) => void;
  /** The resource name, shown when the search title is empty. */
  fallbackTitle: string;
  /** Plain text shown when the search description is empty. */
  fallbackDescription?: string;
  /** Storefront path when the resource has no handle, e.g. `/collections/<id>`. */
  path?: string;
  /** Inline field errors from the form (already translated). */
  errors?: Partial<Record<"title" | "description" | "handle", string>>;
  disabled?: boolean;
}

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
      <p className="truncate text-sm text-muted-foreground">{url}</p>
      <p className="line-clamp-2 text-lg leading-snug text-primary">{title}</p>
      {description ? (
        <p className="line-clamp-2 text-sm text-muted-foreground">{description}</p>
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
  errors = {},
  disabled = false,
}: SearchListingCardProps) {
  const t = useMessages(searchListingMessages);
  const id = useId();
  const [editing, setEditing] = useState(false);
  const { storefrontUrl } = useStorefrontUrl();
  const origin = (storefrontUrl ?? "").replace(/\/+$/, "");
  const prefix = PATH_PREFIX[resource];
  const shownPath = path ?? `${prefix}${value.handle ?? ""}`;
  const title = value.title.trim() || fallbackTitle.trim();
  const description = (value.description.trim() || fallbackDescription.trim()).slice(0, 320);
  const open = editing || Object.values(errors).some(Boolean);

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 p-4">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("edit")}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setEditing((current) => !current)}
        >
          <Pencil className="size-4" />
        </Button>
      </div>
      <div className="space-y-4 px-4 pb-4">
        {title ? (
          <SearchListingPreview url={`${origin}${shownPath}`} title={title} description={description} />
        ) : (
          <p className="text-sm text-muted-foreground">{t(`empty_${resource}`)}</p>
        )}
        {value.hidden ? <p className="text-sm text-muted-foreground">{t("hiddenNote")}</p> : null}

        {open ? (
          <div className="space-y-4 border-t pt-4">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-title`}>{t("pageTitle")}</Label>
              <Input
                id={`${id}-title`}
                value={value.title}
                placeholder={fallbackTitle}
                disabled={disabled}
                aria-invalid={Boolean(errors.title)}
                onChange={(event) => onChange({ title: event.target.value })}
              />
              <p className="text-sm text-muted-foreground">
                {errors.title ?? t("charactersUsed", { count: value.title.length, limit: SEARCH_TITLE_LENGTH })}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-description`}>{t("metaDescription")}</Label>
              <Textarea
                id={`${id}-description`}
                value={value.description}
                disabled={disabled}
                aria-invalid={Boolean(errors.description)}
                onChange={(event) => onChange({ description: event.target.value })}
                rows={3}
              />
              <p className="text-sm text-muted-foreground">
                {errors.description ??
                  t("charactersUsed", { count: value.description.length, limit: SEARCH_DESCRIPTION_LENGTH })}
              </p>
            </div>
            {value.handle !== undefined ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-handle`}>{t("urlHandle")}</Label>
                <div className="flex h-10 items-center overflow-hidden rounded-md border border-input focus-within:ring-2 focus-within:ring-ring">
                  <span className="shrink-0 border-r bg-muted px-3 py-2 text-sm text-muted-foreground">{prefix}</span>
                  <input
                    id={`${id}-handle`}
                    value={value.handle}
                    disabled={disabled}
                    aria-invalid={Boolean(errors.handle)}
                    onChange={(event) => onChange({ handle: event.target.value })}
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
                  />
                </div>
                {errors.handle ? <p className="text-sm text-destructive">{errors.handle}</p> : null}
              </div>
            ) : null}
            <label className="flex items-start gap-3 text-sm">
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
            {value.excludeFromFeed !== undefined ? (
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={value.excludeFromFeed}
                  disabled={disabled}
                  onCheckedChange={(checked) => onChange({ excludeFromFeed: checked === true })}
                  className="mt-0.5"
                />
                <span>
                  {t("excludeFromFeed")}
                  <span className="block text-muted-foreground">{t("excludeFromFeedHelp")}</span>
                </span>
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
