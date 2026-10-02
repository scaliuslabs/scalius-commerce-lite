import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus } from "lucide-react";
import { STOREFRONT_DENSITIES, STOREFRONT_MAX_LANDING_PAGES, storefrontLandingPageSchema, storefrontLandingSlugSchema, type StorefrontPageBlockId, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { onlineStoreMessages } from "~/i18n/online-store";
import type { SetTheme } from "../theme-fields";

export type EditorPage = "home" | "product" | "collection" | "search" | `landing:${string}`;
export type FixedEditorPage = "product" | "collection" | "search";
const BLOCK_LABEL = {
  gallery: "block_gallery", "title-price": "block_titlePrice", options: "block_options", "buy-buttons": "block_buyButtons",
  description: "block_description", specs: "block_specs", reviews: "block_reviews", "related-products": "block_relatedProducts",
  apps: "block_apps", breadcrumbs: "block_breadcrumbs", banner: "block_banner", filters: "block_filters", grid: "block_grid",
} as const;

export function PageSelector({ theme, page, onPage, setDraft }: { theme: StorefrontThemeDocument; page: EditorPage; onPage: (page: EditorPage) => void; setDraft: SetTheme }) {
  const t = useMessages(themeEditorMessages);
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const valid = storefrontLandingSlugSchema.safeParse(slug).success && !theme.pages.landing[slug]
    && storefrontLandingPageSchema.safeParse({ title, sections: [], overrideCms: false }).success;
  const limit = Object.keys(theme.pages.landing).length >= STOREFRONT_MAX_LANDING_PAGES;
  return (
    <div className="space-y-2 border-b border-border p-3">
      <Label htmlFor="theme-editor-page">{t("page")}</Label>
      <SearchableSelect id="theme-editor-page" value={page} options={[
        ...(["home", "product", "collection", "search"] as const).map((value) => ({ value, label: t(`page_${value}`) })),
        ...Object.entries(theme.pages.landing).map(([key, value]) => ({ value: `landing:${key}`, label: value.title, description: `/pages/${key}` })),
      ]} onValueChange={(value) => onPage(value as EditorPage)} />
      <Button type="button" variant="ghost" size="sm" disabled={limit} onClick={() => setOpen(true)}><Plus aria-hidden="true" />{t("newLanding")}</Button>
      {limit ? <p className="text-body text-muted-foreground">{t("landingLimit")}</p> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("newLanding")}</DialogTitle><DialogDescription>{t("landingSlugHelp")}</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label htmlFor="new-landing-title">{t("landingTitle")}</Label><Input id="new-landing-title" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="new-landing-slug">{t("landingSlug")}</Label><Input id="new-landing-slug" value={slug} maxLength={100} aria-invalid={slug !== "" && !valid} aria-describedby="landing-slug-help" onChange={(event) => setSlug(event.target.value)} /><p id="landing-slug-help" className="text-body text-muted-foreground">{slug && !valid ? t("landingSlugInvalid") : `/pages/${slug}`}</p></div>
          </div>
          <DialogFooter><Button type="button" disabled={!valid} onClick={() => {
            setDraft((current) => ({ ...current, pages: { ...current.pages, landing: { ...current.pages.landing, [slug]: { title, sections: [], overrideCms: false } } } }));
            onPage(`landing:${slug}`); setOpen(false); setSlug(""); setTitle("");
          }}>{t("addLanding")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function LandingSettings({ slug, theme, setDraft }: { slug: string; theme: StorefrontThemeDocument; setDraft: SetTheme }) {
  const t = useMessages(themeEditorMessages);
  const page = theme.pages.landing[slug];
  if (!page) return null;
  const update = (patch: Partial<typeof page>) => setDraft((current) => ({ ...current, pages: { ...current.pages, landing: { ...current.pages.landing, [slug]: { ...current.pages.landing[slug]!, ...patch } } } }));
  return <div className="space-y-3"><div className="space-y-1"><Label htmlFor="landing-title">{t("landingTitle")}</Label><Input id="landing-title" value={page.title} maxLength={120} onChange={(event) => update({ title: event.target.value })} /></div><div className="flex items-start gap-2"><Switch id="landing-override" checked={page.overrideCms} onCheckedChange={(overrideCms) => update({ overrideCms })} /><Label htmlFor="landing-override">{t("overrideCms")}</Label></div></div>;
}

export function TemplateBlocks({ page, theme, setDraft }: { page: FixedEditorPage; theme: StorefrontThemeDocument; setDraft: SetTheme }) {
  const t = useMessages(themeEditorMessages);
  const store = useMessages(onlineStoreMessages);
  const blocks = theme.pages[page].blocks;
  const update = (next: typeof blocks) => setDraft((current) => ({ ...current, pages: { ...current.pages, [page]: { ...current.pages[page], blocks: next } } }));
  const move = (from: number, to: number) => { const next = [...blocks]; const [block] = next.splice(from, 1); next.splice(to, 0, block!); update(next); };
  return <div className="space-y-3">{page !== "product" ? <div className="space-y-1"><Label htmlFor="template-grid-density">{store("density")}</Label><SearchableSelect id="template-grid-density" value={theme.tokens.density} options={STOREFRONT_DENSITIES.map((value) => ({ value, label: store(`density_${value}`), description: store(`density_${value}Help`) }))} onValueChange={(density) => setDraft((current) => ({ ...current, tokens: { ...current.tokens, density: density as typeof current.tokens.density } }))} /><p className="text-body text-muted-foreground">{store("densityHelp")}</p></div> : null}<p className="text-body text-muted-foreground">{t("templateHelp")}</p><ol aria-label={t(`page_${page}`)} className="space-y-1">{blocks.map((block, index) => {
    const name = t(BLOCK_LABEL[block.id as StorefrontPageBlockId]);
    return <li key={block.id} data-template-block={block.id} className="flex min-h-12 items-center gap-1 rounded-lg px-2 hover:bg-muted"><span className="mr-auto text-body">{name}{block.hidden ? <span className="block text-muted-foreground">{t("hidden")}</span> : null}</span><Button type="button" variant="ghost" size="icon" disabled={index === 0} aria-label={`${t("moveUp")}: ${name}`} onClick={() => move(index, index - 1)}><ArrowUp aria-hidden="true" /></Button><Button type="button" variant="ghost" size="icon" disabled={index === blocks.length - 1} aria-label={`${t("moveDown")}: ${name}`} onClick={() => move(index, index + 1)}><ArrowDown aria-hidden="true" /></Button><Button type="button" variant="ghost" size="icon" aria-label={`${t(block.hidden ? "show" : "hide")}: ${name}`} aria-pressed={!block.hidden} onClick={() => update(blocks.map((each) => each.id === block.id ? { ...each, hidden: !each.hidden } : each))}>{block.hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</Button></li>;
  })}</ol></div>;
}
