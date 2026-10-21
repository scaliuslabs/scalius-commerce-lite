/**
 * The product page's app blocks: the blocks installed apps add to every
 * product page, in the merchant's order, each with the settings its app
 * declares. Where a block sits (the buy box or below the product) is its
 * app's choice, so the list says it rather than asking. A block whose app is
 * not active stays in the theme, shows nothing, and can be removed.
 */
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { PLUGIN_PRODUCT_BLOCKS_MAX } from "@scalius/shared/plugins/storefront";
import type { StorefrontProductAppBlock } from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorFull } from "~/i18n/theme-editor-panes";
import type { ThemeApp, ThemeAppBlock } from "~/lib/api-query-options/online-store";
import { appSettingDefaults, themeAppFields } from "../schema-form/app-settings";
import { AppSettingFields } from "../schema-form/AppSettingFields";
import type { MediaPreviews } from "../schema-form/media-previews";
import type { SetTheme, Theme } from "../theme-fields";
import { StorefrontProblemNotice } from "~/components/admin/apps/StorefrontProblemNotice";
import {
  addProductAppBlock,
  appBlocksByKey,
  moveProductAppBlock,
  productAppBlockFieldPrefix,
  productAppBlocks,
  removeProductAppBlock,
  setProductAppBlockValues,
  setProductAppBlockBindings,
  type AppBlockEntry,
} from "../theme-settings";

function usePlacementName() {
  const t = useMessages(themeEditorFull);
  return (placement: ThemeAppBlock["placement"]) => t(placement === "product.buy_box.before" ? "appBlockPlacement_buyBoxBefore" : placement === "product.buy_box.after" ? "appBlockPlacement_buyBox" : "appBlockPlacement_below");
}

function AppBlockItem({ block, entry, index, count, media, setDraft }: {
  block: StorefrontProductAppBlock;
  entry: AppBlockEntry | undefined;
  index: number;
  count: number;
  media: MediaPreviews;
  setDraft: SetTheme;
}) {
  const t = useMessages(themeEditorFull);
  const store = useMessages(onlineStoreMessages);
  const placement = usePlacementName();
  const name = entry?.block.name ?? block.app;
  return (
    <li data-app-block={block.id} className="space-y-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-heading-sm">{name}</p>
          <p className="text-body text-muted-foreground">
            {entry ? `${entry.app.name} · ${placement(entry.block.placement)}` : t("appInactive")}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={store("moveSectionUp", { name })} disabled={index === 0} onClick={() => setDraft((current) => moveProductAppBlock(current, block.id, -1))}>
          <ArrowUp aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={store("moveSectionDown", { name })} disabled={index === count - 1} onClick={() => setDraft((current) => moveProductAppBlock(current, block.id, 1))}>
          <ArrowDown aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={store("removeItem", { name })} onClick={() => setDraft((current) => removeProductAppBlock(current, block.id))}>
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      {entry ? <StorefrontProblemNotice appId={block.app.split("/")[0] ?? ""} part={{ kind: "component", type: block.app.split("/")[1] ?? "" }} /> : null}
      {!entry ? (
        <p className="text-body text-muted-foreground">{t("appBlockInactiveHelp")}</p>
      ) : themeAppFields(entry.block.settings).length > 0 ? (
        <AppSettingFields
          idPrefix={productAppBlockFieldPrefix(block.id)}
          fields={entry.block.settings}
          values={block.values}
          bindings={block.bindings}
          onBindingsChange={(bindings) => setDraft((current) => setProductAppBlockBindings(current, block.id, bindings))}
          media={media}
          onChange={(values) => setDraft((current) => setProductAppBlockValues(current, block.id, values))}
        />
      ) : (
        <p className="text-body text-muted-foreground">{t("appBlockNoSettings")}</p>
      )}
    </li>
  );
}

export function ProductAppBlocksSettings({ theme, apps, media, setDraft }: { theme: Theme; apps: readonly ThemeApp[]; media: MediaPreviews; setDraft: SetTheme }) {
  const t = useMessages(themeEditorFull);
  const placement = usePlacementName();
  const byKey = appBlocksByKey(apps);
  const blocks = productAppBlocks(theme);
  const full = blocks.length >= PLUGIN_PRODUCT_BLOCKS_MAX;
  return (
    <div className="space-y-4" data-product-app-blocks>
      <p className="text-body text-muted-foreground">{t("appBlocksHelp")}</p>
      {blocks.length > 0 ? (
        <ol className="space-y-3" aria-label={t("appBlocks")}>
          {blocks.map((block, index) => (
            <AppBlockItem key={block.id} block={block} entry={byKey.get(block.app)} index={index} count={blocks.length} media={media} setDraft={setDraft} />
          ))}
        </ol>
      ) : (
        <p className="text-body text-muted-foreground">{t(byKey.size > 0 ? "appBlocksNone" : "appBlocksNoApps")}</p>
      )}
      {byKey.size > 0 ? (
        <SearchableSelect
          value=""
          placeholder={t("addAppBlock")}
          ariaLabel={t("addAppBlock")}
          disabled={full}
          options={[...byKey.values()].map(({ app, block }) => ({
            value: block.key,
            label: block.name,
            description: `${app.name} · ${placement(block.placement)}`,
          }))}
          onValueChange={(key) => {
            const entry = byKey.get(key);
            if (!entry) return;
            setDraft((current) => addProductAppBlock(current, key, appSettingDefaults(entry.block.settings))?.theme ?? current);
          }}
          triggerClassName="w-full"
        />
      ) : null}
      {full ? <p className="text-body text-muted-foreground">{t("appBlockLimit", { count: PLUGIN_PRODUCT_BLOCKS_MAX })}</p> : null}
    </div>
  );
}
