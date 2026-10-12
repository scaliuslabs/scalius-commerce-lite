/**
 * Choosing what the editor shows, Shopify's page switcher in the centre of
 * the top bar (research P21): the homepage, the product, collection,
 * category, cart and CMS page templates, search results and the theme's
 * landing pages (and making a new one). Product, collection, category and
 * CMS pages preview one of the store's own; the tree says which ("Previewing
 * …"), with a way to change it.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Plus } from "lucide-react";
import {
  STOREFRONT_LANDING_TITLE_MAX,
  STOREFRONT_MAX_LANDING_PAGES,
  storefrontLandingSlugSchema,
} from "@scalius/shared/storefront-theme";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "~/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { navigationResourcesQueryOptions, type NavigationResourceOption } from "~/lib/api-query-options/navigation";
import { NavigationResourcePicker } from "../NavigationResourcePicker";
import type { Theme } from "../theme-fields";
import { STORE_PAGE_KINDS, samePage, type EditorPage, type ResourcePageKind } from "./editor-pages";
import { Field } from "~/components/ui/field";
import { Badge } from "~/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import type { LandingPreset } from "./landing-presets";

const ProductSelect = lazy(() => import("../schema-form/resource-fields").then((module) => ({ default: module.ProductSelect })));

/** The "blank page" choice (preset keys always hold a slash). */
const BLANK = "blank";

export function usePageName() {
  const t = useMessages(themeEditorMessages);
  return (page: EditorPage, theme: Theme): string =>
    page.kind === "landing" ? theme.pages.landing[page.slug]?.title ?? page.slug : t(`page_${page.kind}`);
}

export function PagePicker({ theme, page, onPage, onCreate, className }: {
  theme: Theme;
  page: EditorPage;
  onPage: (page: EditorPage) => void;
  /** Absent for staff who may only view the theme. */
  onCreate?: () => void;
  className?: string;
}) {
  const t = useMessages(themeEditorMessages);
  const name = usePageName();
  const [open, setOpen] = useState(false);
  const landing = Object.entries(theme.pages.landing);
  const choose = (next: EditorPage) => {
    onPage(next);
    setOpen(false);
  };
  const item = (value: EditorPage, label: string, description?: string) => (
    <CommandItem key={value.kind === "landing" ? `landing:${value.slug}` : value.kind} value={`${label} ${description ?? ""}`} onSelect={() => choose(value)} className="cursor-pointer">
      <Check className={samePage(value, page) ? "size-4 opacity-100" : "size-4 opacity-0"} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {description ? <span className="block truncate text-muted-foreground">{description}</span> : null}
      </span>
    </CommandItem>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-page-picker
          aria-label={t("pagePicker", { page: name(page, theme) })}
          className={cn("flex h-11 min-w-0 sm:h-9 items-center justify-between gap-2 rounded-lg bg-topbar-subdued px-3 text-body font-medium text-topbar-foreground hover:bg-topbar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-topbar-progress", className)}
        >
          <span className="min-w-0 truncate">{name(page, theme)}</span>
          <ChevronDown className="size-4 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-80 p-0">
        <Command>
          <CommandInput aria-label={t("findPage")} placeholder={t("findPage")} />
          <CommandList>
            <CommandGroup heading={t("pageGroupStore")}>
              {STORE_PAGE_KINDS.map((kind) => item({ kind } as EditorPage, t(`page_${kind}`), t(`pageHint_${kind}`)))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={t("landingPages")}>
              {landing.map(([slug, value]) => item({ kind: "landing", slug }, value.title, `/pages/${slug}`))}
              {onCreate ? (
                <CommandItem
                  value={t("newLanding")}
                  disabled={landing.length >= STOREFRONT_MAX_LANDING_PAGES}
                  onSelect={() => { setOpen(false); onCreate(); }}
                  className="cursor-pointer"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  <span>{landing.length >= STOREFRONT_MAX_LANDING_PAGES ? t("landingLimit") : t("newLanding")}</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
        {/* Pages a store has that this editor does not list, and why. */}
        <p className="border-t border-border px-3 py-2 text-body text-muted-foreground">{t("otherPagesNote")}</p>
      </PopoverContent>
    </Popover>
  );
}

/** A URL handle from a title: lowercase Latin letters and digits joined by hyphens. */
function landingHandle(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

/** Naming a new landing page: its title and the handle in its address. */
export function CreateLandingDialog({ open, onOpenChange, theme, presets = [], onCreate }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme: Theme;
  /** Ready-made pages installed apps offer; the page may start from one. */
  presets?: readonly LandingPreset[];
  onCreate: (slug: string, title: string, start: { preset: LandingPreset; productId: string | null } | null) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [presetKey, setPresetKey] = useState(BLANK);
  const [productId, setProductId] = useState("");
  useEffect(() => {
    if (!open) { setTitle(""); setSlug(""); setSlugEdited(false); setPresetKey(BLANK); setProductId(""); }
  }, [open]);
  const handle = slugEdited ? slug : landingHandle(title);
  const taken = Boolean(theme.pages.landing[handle]);
  const handleValid = storefrontLandingSlugSchema.safeParse(handle).success && !taken;
  const preset = presets.find((each) => each.key === presetKey) ?? null;
  const valid = handleValid && title.trim().length > 0 && (!preset?.needsProduct || productId !== "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("newLanding")}</DialogTitle>
          <DialogDescription>{t("newLandingHelp")}</DialogDescription>
        </DialogHeader>
        <form
          id="new-landing-form"
          method="post"
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onCreate(handle, title.trim(), preset ? { preset, productId: productId || null } : null);
          }}
        >
          <Field id="new-landing-title" label={t("landingTitle")}>
            <Input id="new-landing-title" value={title} maxLength={STOREFRONT_LANDING_TITLE_MAX} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </Field>
          <Field id="new-landing-slug" label={t("landingSlug")}>
            <Input
              id="new-landing-slug"
              value={handle}
              maxLength={100}
              aria-invalid={handle !== "" && !handleValid}
              aria-describedby="landing-slug-help"
              onChange={(event) => { setSlugEdited(true); setSlug(event.target.value); }}
            />
            <p id="landing-slug-help" className={handle !== "" && !handleValid ? "text-body text-destructive" : "text-body text-muted-foreground"}>
              {handle !== "" && !handleValid ? t(taken ? "landingSlugTaken" : "landingSlugInvalid") : t("landingSlugHelp", { path: `/pages/${handle || "…"}` })}
            </p>
          </Field>
          {presets.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-body font-medium">{t("landingStart")}</legend>
              <RadioGroup value={presetKey} onValueChange={setPresetKey}>
                {[
                  { value: BLANK, label: t("landingBlank"), help: t("landingBlankHelp"), app: null },
                  ...presets.map((each) => ({ value: each.key, label: each.name, help: each.description, app: each.appName })),
                ].map((option) => (
                  <label key={option.value} className="flex min-h-11 items-start gap-3 rounded-md px-2 py-1.5 text-body hover:bg-muted">
                    <span className="flex h-lh items-center"><RadioGroupItem value={option.value} /></span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {option.label}
                        {option.app ? <Badge variant="secondary">{t("appBadge")}</Badge> : null}
                      </span>
                      {option.help || option.app ? (
                        <span className="block text-muted-foreground">
                          {[option.help, option.app ? t("appFrom", { app: option.app }) : null].filter(Boolean).join(" ")}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
          ) : null}
          {preset?.needsProduct ? (
            <Field id="new-landing-product" label={t("landingProduct")}>
              <Suspense fallback={<Input id="new-landing-product" disabled aria-busy="true" />}>
                <ProductSelect id="new-landing-product" value={productId} onChange={setProductId} />
              </Suspense>
              <p className="text-body text-muted-foreground">{t("landingProductHelp")}</p>
            </Field>
          ) : null}
        </form>
        <DialogFooter>
          <Button type="submit" form="new-landing-form" disabled={!valid}>{t("addLanding")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The store's first product (collection, category, page) for a page that
 * previews one, until the merchant picks another. Null while it loads or
 * when the store has none (or the staff member may not browse them).
 */
export function useDefaultResource(kind: ResourcePageKind | null) {
  const query = useInfiniteQuery({
    ...navigationResourcesQueryOptions({ type: kind ?? "product", limit: 1 }),
    enabled: kind !== null,
  });
  const first = query.data?.pages[0]?.items.find((item) => item.available) ?? null;
  return { resource: first, loading: kind !== null && query.isPending, failed: query.isError };
}

/** "Previewing Cotton shirt · Change", above the tree of a page that shows one of the store's own. */
export function PreviewResource({ kind, resource, loading, failed, onChange }: {
  kind: ResourcePageKind;
  resource: NavigationResourceOption | null;
  loading: boolean;
  failed: boolean;
  onChange: (resource: NavigationResourceOption) => void;
}) {
  const t = useMessages(themeEditorMessages);
  return (
    // One line, the same height as every page's strip (the tree below never moves between pages).
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4" data-preview-resource={kind}>
      <p className="min-w-0 flex-1 truncate text-body">
        {resource ? (
          <>
            <span className="text-muted-foreground">{t("previewing")}: </span>
            <span className="font-medium">{resource.name}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{t(loading ? "previewLoading" : failed ? "resourceFailed" : `resourceNone_${kind}`)}</span>
        )}
      </p>
      <NavigationResourcePicker
        id={`theme-preview-${kind}`}
        type={kind}
        value={resource?.id ?? ""}
        onValueChange={onChange}
        trigger={<Button type="button" variant="outline" size="sm" disabled={failed}>{t(resource ? "changePreview" : "choosePreview")}</Button>}
      />
    </div>
  );
}

/** The strip above the tree on a page previewed without a chosen record: what the page is, at the same height as PreviewResource. */
export function PageStrip({ text }: { text: string }) {
  return <p className="flex h-12 shrink-0 items-center truncate border-b border-border px-4 text-body text-muted-foreground" data-page-strip>{text}</p>;
}
