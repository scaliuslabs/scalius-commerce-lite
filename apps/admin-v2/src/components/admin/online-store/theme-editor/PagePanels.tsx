/**
 * A page's own settings: what the homepage shows (its sections, or one
 * product's page), a landing page's search engine listing (title,
 * description, address, hidden from search engines), and where a CMS page's
 * words are edited.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  STOREFRONT_LANDING_DESCRIPTION_MAX,
  STOREFRONT_LANDING_TITLE_MAX,
} from "@scalius/shared/storefront-theme";
import { SearchListingCard } from "~/components/admin/search-listing/SearchListingCard";
import { Button } from "~/components/ui/button";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { fetchProducts, productsByIdsQueryOptions } from "~/lib/api-query-options/products";
import { Field } from "../shared";
import type { SetTheme, Theme } from "../theme-fields";
import { THEME_FIELD_IDS } from "../theme-settings";

const HOME_PRODUCT_PAGE_SIZE = 20;
const loadHomeProducts: SearchableSelectLoader = async ({ search, page }) => {
  const result = await fetchProducts({ page, limit: HOME_PRODUCT_PAGE_SIZE, ...(search ? { search } : {}) });
  return {
    options: result.products.map((product) => ({ value: product.id, label: product.name })),
    hasMore: page < result.pagination.totalPages,
  };
};

/**
 * What `/` shows: the homepage sections, or one product's page (a store that
 * sells one product). A one-product homepage cannot be saved without its product.
 */
export function HomePageSettings({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(onlineStoreMessages);
  const mode = theme.pages.homeMode;
  const productId = mode.kind === "product" ? mode.productId : "";
  // Switching to sections and back keeps the product chosen before.
  const [lastProduct, setLastProduct] = useState(productId);
  const { data } = useQuery(productsByIdsQueryOptions(productId ? [productId] : []));
  const productName = data?.products.find((product) => product.id === productId)?.name;
  const setMode = (homeMode: Theme["pages"]["homeMode"]) =>
    setDraft((current) => ({ ...current, pages: { ...current.pages, homeMode } }));
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-body font-medium">{t("homeMode")}</p>
        <p className="text-body text-muted-foreground">{t("homeModeHelp")}</p>
      </div>
      <RadioGroup
        value={mode.kind}
        aria-label={t("homeMode")}
        onValueChange={(kind) => setMode(kind === "product" ? { kind: "product", productId: productId || lastProduct } : { kind: "sections" })}
      >
        {(["sections", "product"] as const).map((value) => (
          <label key={value} className="flex min-h-11 items-start gap-3 py-1 text-body">
            <RadioGroupItem value={value} className="mt-0.5" />
            <span>
              <span className="block font-medium">{t(`homeMode_${value}`)}</span>
              <span className="block text-muted-foreground">{t(`homeMode_${value}Help`)}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {mode.kind === "product" ? (
        <Field id={THEME_FIELD_IDS.homeProduct} label={t("homeProduct")} error={productId ? undefined : t("chooseProduct")}>
          <SearchableSelect
            id={THEME_FIELD_IDS.homeProduct}
            value={productId}
            selectedLabel={productName}
            load={loadHomeProducts}
            queryKey={["online-store", "home-product"]}
            onValueChange={(value) => {
              setLastProduct(value);
              setMode({ kind: "product", productId: value });
            }}
            placeholder={t("chooseProduct")}
            searchPlaceholder={t("searchProducts")}
            emptyMessage={t("noProducts")}
            triggerClassName="w-full"
          />
        </Field>
      ) : null}
    </div>
  );
}

/**
 * A landing page's search engine listing (the shared card every resource
 * uses): its title (the page's `<title>` and heading), description, address
 * and whether search engines may list it; and removing the page. Its handle
 * is fixed once created: a new address is a new page.
 */
export function LandingPageSettings({ theme, slug, setDraft, onRemove }: {
  theme: Theme;
  slug: string;
  setDraft: SetTheme;
  onRemove: () => void;
}) {
  const t = useMessages(themeEditorMessages);
  const page = theme.pages.landing[slug];
  if (!page) return null;
  const update = (patch: Partial<typeof page>) => setDraft((current) => {
    const existing = current.pages.landing[slug];
    return existing ? { ...current, pages: { ...current.pages, landing: { ...current.pages.landing, [slug]: { ...existing, ...patch } } } } : current;
  });
  return (
    <div className="space-y-4">
      <SearchListingCard
        resource="page"
        path={`/pages/${slug}`}
        value={{ title: page.title, description: page.description, hidden: page.noIndex === true }}
        fallbackTitle=""
        errors={{
          title: page.title.trim() === "" ? t("landingTitleRequired") : undefined,
          description: page.description.length > STOREFRONT_LANDING_DESCRIPTION_MAX ? t("landingDescriptionTooLong", { max: STOREFRONT_LANDING_DESCRIPTION_MAX }) : undefined,
        }}
        onChange={(next) => update({
          ...(next.title !== undefined ? { title: next.title.slice(0, STOREFRONT_LANDING_TITLE_MAX) } : {}),
          ...(next.description !== undefined ? { description: next.description } : {}),
          // Hiding a page from search engines also leaves the sitemap; showing it again keeps the stored sitemap choice.
          ...(next.hidden !== undefined ? { noIndex: next.hidden || undefined } : {}),
        })}
      />
      <Button type="button" variant="destructive" size="sm" onClick={onRemove}>{t("removeLanding")}</Button>
    </div>
  );
}

/** The cart and checkout form: their fields and words follow the checkout settings; the template adds sections around them. */
export function CartContent() {
  const t = useMessages(themeEditorMessages);
  return (
    <div className="space-y-3">
      <p className="text-body text-muted-foreground">{t("cartMainHelp")}</p>
      <Button asChild variant="outline">
        <Link to="/admin/settings/checkout">{t("editCheckout")}</Link>
      </Button>
    </div>
  );
}

/** A CMS page's words are a page in Content; the editor shows it in the store's header and footer. */
export function CmsPageContent({ pageId }: { pageId: string | null }) {
  const t = useMessages(themeEditorMessages);
  return (
    <div className="space-y-3">
      <p className="text-body text-muted-foreground">{t("pageContentHelp")}</p>
      {pageId ? (
        <Button asChild variant="outline">
          <Link to="/admin/pages/$pageId/edit" params={{ pageId }}>{t("editPageContent")}</Link>
        </Button>
      ) : null}
    </div>
  );
}
