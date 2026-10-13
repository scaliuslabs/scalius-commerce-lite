/**
 * Choosing what the editor shows, Shopify's page switcher in the centre of
 * the top bar (research P21): the homepage, the product, collection,
 * category, cart and CMS page templates, search results and the theme's
 * landing pages (and making a new one). Product, collection, category and
 * CMS pages preview one of the store's own; the tree says which ("Previewing
 * …"), with a way to change it.
 */
import { lazy, Suspense, useRef, useState, type ComponentProps } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Plus } from "lucide-react";
import {
  STOREFRONT_MAX_LANDING_PAGES,
} from "@scalius/shared/storefront-theme";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "~/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { navigationResourcesQueryOptions, type NavigationResourceOption } from "~/lib/api-query-options/navigation";
import { NavigationResourcePicker } from "../NavigationResourcePicker";
import type { Theme } from "../theme-fields";
import { STORE_PAGE_KINDS, samePage, type EditorPage, type ResourcePageKind } from "./editor-pages";

const loadCreateLandingDialog = () => import("./CreateLandingDialog");
const CreateLandingDialogContent = lazy(() => loadCreateLandingDialog().then((module) => ({ default: module.CreateLandingDialogContent })));

/** Keep the dialog/focus scope and close animation while the form downloads only on first use. */
export function CreateLandingDialog(props: ComponentProps<typeof CreateLandingDialogContent> & { onOpenChange: (open: boolean) => void }) {
  const t = useMessages(themeEditorMessages);
  const opened = useOpenedOnce(props.open);
  const open = useRef(props.open);
  open.current = props.open;
  const restorePickerFocus = (event: Event) => {
    // The menu item that opens this dialog unmounts with its popover.
    // Keep focus inside during the lazy handoff; return to the live picker on close.
    event.preventDefault();
    if (!open.current) document.querySelector<HTMLButtonElement>("[data-page-picker]")?.focus();
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {opened ? <Suspense fallback={
        <DialogContent aria-busy="true" onCloseAutoFocus={restorePickerFocus}>
          <DialogHeader>
            <DialogTitle>{t("newLanding")}</DialogTitle>
            <DialogDescription>{t("newLandingHelp")}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      }><CreateLandingDialogContent {...props} onCloseAutoFocus={restorePickerFocus} /></Suspense> : null}
    </Dialog>
  );
}

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
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next && onCreate) void loadCreateLandingDialog().catch(() => undefined); }}>
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
