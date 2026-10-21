/**
 * The product page as the editor's blocks: the product information area
 * (gallery, buy box, sticky bars), the modules below it (ordered, each shown
 * or hidden) and the app blocks. They are the theme's `blocks.product`, the
 * same template every product page renders.
 */
import {
  STOREFRONT_PRODUCT_STICKY,
  storefrontBlockVariants,
  type ResolvedStorefrontTheme,
  type ResolvedStorefrontThemeLayout,
  type StorefrontProductModule,
} from "@scalius/shared/storefront-theme";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorFull } from "~/i18n/theme-editor-panes";
import type { MediaPreviews } from "../schema-form/resource-fields";
import { BlockSettingsFields, FitNote, useFitReason, variantRenders, type SetTheme, type Theme } from "../theme-fields";
import { BuyBoxSketch, ProductPageSketch, VisualChoice } from "../ThemeChoices";
import { blockFallback, blockVariant, setBlockVariant, toggleProductModule } from "../theme-settings";
import { SwitchField } from "./ListingPanels";
import { Field } from "~/components/ui/field";

type MessageKey = keyof (typeof onlineStoreMessages)["en"];
type Product = Theme["blocks"]["product"];

const setProduct = (setDraft: SetTheme, update: (product: Product) => Product) =>
  setDraft((current) => ({ ...current, blocks: { ...current.blocks, product: update(current.blocks.product) } }));

/** The gallery and buy box (the top of every product page) and the sticky bars. */
export function ProductMainSettings({ theme, resolved, media, setDraft }: {
  theme: Theme;
  resolved: ResolvedStorefrontTheme;
  media: MediaPreviews;
  setDraft: SetTheme;
}) {
  const t = useMessages(onlineStoreMessages);
  const editor = useMessages(themeEditorFull);
  const fitReason = useFitReason(resolved.facts);
  const sticky = theme.blocks.product.sticky;
  const setSticky = (next: Partial<Product["sticky"]>) =>
    setProduct(setDraft, (current) => ({ ...current, sticky: { ...current.sticky, ...next } }));
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <VisualChoice
          label={t("productPage")}
          showLabel
          value={blockVariant(theme, "gallery")}
          className="grid-cols-2"
          options={storefrontBlockVariants("gallery").map((value) => ({
            value,
            label: t(`productPage_${value}` as MessageKey),
            sketch: <ProductPageSketch layout={variantRenders<ResolvedStorefrontThemeLayout["productPage"]>("gallery", value)} />,
          }))}
          onChange={(variant) => setDraft((current) => setBlockVariant(current, "gallery", variant))}
        />
        <BlockSettingsFields slot="gallery" theme={theme} setDraft={setDraft} media={media} />
      </div>
      <div className="space-y-3 border-t border-border pt-4">
        <VisualChoice
          label={t("purchasePanel")}
          showLabel
          value={blockVariant(theme, "buyBox")}
          className="grid-cols-2"
          options={storefrontBlockVariants("buyBox").map((value) => ({
            value,
            label: t(`buyBox_${value}` as MessageKey),
            sketch: <BuyBoxSketch box={variantRenders<ResolvedStorefrontThemeLayout["buyBox"]>("buyBox", value)} />,
          }))}
          onChange={(variant) => setDraft((current) => setBlockVariant(current, "buyBox", variant))}
        />
        <FitNote fallback={blockFallback(resolved, "buyBox")} name={(variant) => t(`buyBox_${variant}` as MessageKey)} reason={fitReason} />
        <BlockSettingsFields slot="buyBox" theme={theme} setDraft={setDraft} media={media} />
      </div>
      <div className="space-y-4 border-t border-border pt-4" data-product-page-extras>
        <p className="text-body font-medium">{editor("stickyBars")}</p>
        <SwitchField
          id="theme-sticky-phone-buy-bar"
          label={t("stickyPhoneBuyBar")}
          help={t("stickyPhoneBuyBarHelp")}
          checked={sticky.phoneBottom === "buy-bar"}
          onCheckedChange={(checked) => setSticky({ phoneBottom: checked ? "buy-bar" : "none" })}
        />
        <SwitchField
          id="theme-sticky-phone-anchor-bar"
          label={t("stickyPhoneAnchorBar")}
          help={t("stickyPhoneAnchorBarHelp")}
          checked={sticky.phoneTop === "anchor-bar"}
          onCheckedChange={(checked) => setSticky({ phoneTop: checked ? "anchor-bar" : "none" })}
        />
        <Field id="theme-sticky-desktop" label={t("stickyDesktop")} help={t("stickyDesktopHelp")}>
          <SearchableSelect
            id="theme-sticky-desktop"
            value={sticky.desktop}
            options={STOREFRONT_PRODUCT_STICKY.desktop.map((value) => ({ value, label: t(`stickyDesktop_${value}`) }))}
            onValueChange={(desktop) => setSticky({ desktop: desktop as Product["sticky"]["desktop"] })}
            triggerClassName="w-full"
          />
        </Field>
      </div>
    </div>
  );
}

/** One module below the product: what it shows, and whether product pages show it. */
export function ProductModuleSettings({ theme, module, setDraft }: { theme: Theme; module: StorefrontProductModule; setDraft: SetTheme }) {
  const editor = useMessages(themeEditorFull);
  const shown = theme.blocks.product.below.includes(module);
  return (
    <div className="space-y-4">
      <p className="text-body text-muted-foreground">{editor(`moduleHelp_${module}`)}</p>
      <SwitchField
        id={`theme-product-module-${module}`}
        label={editor("moduleShown")}
        help={editor("moduleShownHelp")}
        checked={shown}
        onCheckedChange={(checked) => setProduct(setDraft, (current) => ({ ...current, below: toggleProductModule(current.below, module, checked) }))}
      />
    </div>
  );
}
