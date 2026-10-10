import { useMemo, useState, type ComponentType } from "react";
import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BadgePercent,
  Barcode,
  Blocks,
  Clock,
  FileText,
  FolderTree,
  Inbox,
  Languages,
  Layers,
  PackageMinus,
  Plug,
  Settings,
  SunMoon,
  Tag,
  Truck,
  UserRound,
} from "lucide-react";
import {
  getApiV1AdminCategories,
  getApiV1AdminCollections,
  getApiV1AdminCustomers,
  getApiV1AdminOrders,
  getApiV1AdminPages,
  getApiV1AdminProducts,
} from "@scalius/api-client/sdk";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { getStoreRegion } from "~/lib/store-time-zone";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useDebounce } from "~/hooks/use-debounce";
import { apiData } from "~/lib/api";
import { appSurfacesQueryOptions } from "~/lib/api-query-options/apps";
import { discountsQueryOptions } from "~/lib/api-query-options/discounts";
import { LOCALES, setLocale, useLocale, useMessages } from "~/i18n";
import { navKeywordMessages } from "~/i18n/nav-keywords";
import { shellMessages } from "~/i18n/shell";
import { settingsNavMessages } from "~/i18n/settings";
import { customersMessages } from "~/i18n/customers";
import { customerTitle } from "~/lib/customer-title";
import { settingsSearchMessages } from "~/i18n/settings-search";
import { appSurfacesMessages } from "~/i18n/app-surfaces";
import type { AppProviderKind } from "../apps/app-capabilities";
import { searchAppSurfaces } from "../apps/app-search";
import { localizedSurfaces } from "../apps/app-text";
import { SETTINGS_NAV } from "../settings/settings-nav";
import { matches, searchSettings, words } from "../settings/settings-search";
import type { VisibleNavItem } from "./AdminNav";
import { goCaps } from "./shortcuts";
import { useTheme } from "./ThemeProvider";

export interface GlobalSearchProps {
  nav: VisibleNavItem[];
  canOpen: (path: string) => boolean;
  /** Destination → the key after G (defaults plus this staff member's choices). */
  goKeys: ReadonlyMap<string, string>;
}

interface Entry {
  id: string;
  label: string;
  /** Where the entry goes; an entry without one runs `run` instead (language, light/dark). */
  to?: string;
  /** A card on a settings page (the settings search's card id). */
  hash?: string;
  search?: Record<string, string>;
  run?: () => void;
  icon: ComponentType<{ className?: string }>;
  hint?: string;
  /** Muted second part of the label: the settings page a card is on, a customer's phone, "Draft". */
  detail?: string;
  /** A customer titled by its phone (a guest without an order name) never goes into the device's recents. */
  titledByPhone?: boolean;
}

type ShellKey = keyof (typeof shellMessages)["en"];
type KeywordKey = keyof (typeof navKeywordMessages)["en"];

/** Shopify caps admin search at 7 results. */
const MAX_RESULTS = 7;
/** Per record type, so one type can't crowd out the others. */
const PER_TYPE = 3;
const RECENT_KEY = "scalius.search.recent";
/** Everyday tasks that live inside a page, found by name like the pages themselves. */
const TASKS: ReadonlyArray<{ key: ShellKey & KeywordKey; to: string; search?: Record<string, string>; icon: Entry["icon"] }> = [
  { key: "lowStock", to: "/admin/inventory", search: { section: "alerts" }, icon: PackageMinus },
  { key: "printLabels", to: "/admin/inventory/labels", icon: Barcode },
  { key: "suppliers", to: "/admin/inventory/suppliers", icon: Truck },
];

/** A page or task matches by its name or the words merchants use for it, in either language. */
function pageWords(key: string): string[] {
  const own = (catalog: Record<string, string>) => catalog[key] ?? "";
  return [shellMessages.en, shellMessages.bn, navKeywordMessages.en, navKeywordMessages.bn].flatMap((catalog) => words(own(catalog)));
}

type Recent = Pick<Entry, "id" | "label" | "detail" | "to" | "hash" | "search">;

function readRecent(): Recent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item.to === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** Remembers what was opened on this device: never the typed query, nor a customer's phone. */
function remember(entry: Entry) {
  if (!entry.to || entry.titledByPhone) return;
  try {
    const { id, label, to, hash, search } = entry;
    const detail = id.startsWith("u:") ? undefined : entry.detail;
    const next = [{ id, label, detail, to, hash, search }, ...readRecent().filter((item) => item.id !== id)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: search still works, only without recents.
  }
}

/**
 * The ⌘K dialog: recently opened places, then for a query the matching
 * dashboard pages, tasks and settings (with G-key hints) and the top orders,
 * customers, discounts, products (SKU and barcode too, drafts included),
 * collections, categories and pages. Records come from the same list
 * endpoints as the list pages, so the two searches never disagree. The query
 * stays in this dialog: nothing goes into the URL.
 */
export function GlobalSearchDialog({ nav, canOpen, goKeys, open, setOpen }: GlobalSearchProps & { open: boolean; setOpen: (open: boolean) => void }) {
  const t = useMessages(shellMessages);
  const customerT = useMessages(customersMessages);
  const settingsPage = useMessages(settingsNavMessages);
  const settingsCard = useMessages(settingsSearchMessages);
  const locale = useLocale();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const term = query.trim();
  const needle = term.toLowerCase();
  const lookupTerm = useDebounce(term, 200);
  const searching = open && lookupTerm.length >= 2;
  const lookup = <T,>(kind: string, path: string, fetch: () => Promise<T>) => ({
    queryKey: ["global-search", kind, lookupTerm],
    queryFn: fetch,
    enabled: searching && canOpen(path),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
  const listQuery = { search: lookupTerm, limit: PER_TYPE };
  const orders = useQuery(lookup("orders", "/admin/orders", () => apiData(getApiV1AdminOrders({ query: listQuery }))));
  const customers = useQuery(lookup("customers", "/admin/customers", () => apiData(getApiV1AdminCustomers({ query: listQuery }))));
  const products = useQuery(lookup("products", "/admin/products", () => apiData(getApiV1AdminProducts({ query: { ...listQuery, view: "compact" } }))));
  const collections = useQuery(lookup("collections", "/admin/collections", () => apiData(getApiV1AdminCollections({ query: listQuery }))));
  const categories = useQuery(lookup("categories", "/admin/categories", () => apiData(getApiV1AdminCategories({ query: listQuery }))));
  const pages = useQuery(lookup("pages", "/admin/pages", () => apiData(getApiV1AdminPages({ query: listQuery }))));
  // Discounts are searched on the server too (name, title, or a code from its start).
  const discounts = useQuery({
    ...discountsQueryOptions({ search: lookupTerm, limit: PER_TYPE }),
    enabled: searching && canOpen("/admin/discounts"),
    placeholderData: keepPreviousData,
    retry: false,
  });
  // Active apps' pages and providers: the shell's cached surfaces read (apps.view).
  const surfacesT = useMessages(appSurfacesMessages);
  const apps = useQuery({ ...appSurfacesQueryOptions(), enabled: open && canOpen("/admin/apps") }).data;

  const places = useMemo<Entry[]>(() => {
    const hint = (to: string) => {
      const key = goKeys.get(to);
      return key ? goCaps(key).join(" ") : undefined;
    };
    const sections = nav.flatMap((item): Entry[] => [
      { id: `nav:${item.key}`, label: t(item.key), to: item.to, icon: ArrowRight, hint: hint(item.to) },
      // App pages carry their own title (and share their section's key, so their address names them).
      ...item.children.map((child) => ({
        id: child.label ? `nav:${child.to}` : `nav:${child.key}`,
        label: child.label ?? t(child.key),
        to: child.to,
        icon: ArrowRight,
        hint: hint(child.to),
      })),
    ]);
    // With no query, offer the sections themselves (their G-key hints teach the shortcuts).
    if (!needle) return sections.filter((entry) => nav.some((item) => `nav:${item.key}` === entry.id));
    const terms = words(needle);
    const found = (key: string) => matches(terms, pageWords(key));
    const tasks: Entry[] = TASKS.filter((task) => canOpen(task.to) && found(task.key))
      .map((task) => ({ id: `task:${task.key}`, label: t(task.key), to: task.to, search: task.search, icon: task.icon }));
    // Settings share one index with the settings column's search: pages, cards
    // ("cod", "courier", "ভ্যাট") and things kept elsewhere (templates, language).
    const settings = searchSettings(needle);
    const settingsPages = SETTINGS_NAV.filter((item) => canOpen(item.to));
    const other = LOCALES.find((option) => option.value !== locale)!;
    const settingEntries: Entry[] = [
      ...settingsPages
        .filter((item) => settings.pages.includes(item.key))
        .map((item) => ({ id: `set:${item.key}`, label: settingsPage(item.key), to: item.to, icon: Settings })),
      ...settings.cards.flatMap((entry): Entry[] => {
        const page = settingsPages.find((item) => item.key === entry.page);
        return page
          ? [{ id: `set:${entry.card}`, label: settingsCard(entry.card), detail: settingsPage(entry.page), to: page.to, hash: entry.card, icon: Settings }]
          : [];
      }),
      ...settings.shortcuts.flatMap((entry): Entry[] => {
        if (entry.card === "dashboardLanguage") {
          return [{ id: "run:language", label: t("switchLanguage", { language: other.label }), icon: Languages, run: () => setLocale(other.value) }];
        }
        if (entry.card === "dashboardAppearance") {
          return [{ id: "run:appearance", label: t(theme === "dark" ? "switchToLight" : "switchToDark"), icon: SunMoon, run: toggleTheme }];
        }
        return "to" in entry && canOpen(entry.to)
          ? [{ id: `set:${entry.card}`, label: settingsCard(entry.card), detail: settingsCard(entry.section), to: entry.to, hash: "hash" in entry ? entry.hash : undefined, icon: Settings }]
          : [];
      }),
    ];
    // App pages are found by their own titles; apps by name; app providers
    // (Pathao, SMS.net.bd) open their setup where their capability lives.
    const navMatches = sections.filter((entry) => found(entry.id.slice(4)) || (entry.id.startsWith("nav:/admin/apps/") && matches(terms, words(entry.label))));
    const installed = (apps ?? []).map((app) => localizedSurfaces(app, locale));
    const kindWords = (kind: AppProviderKind) => [appSurfacesMessages.en[`kind_${kind}`], appSurfacesMessages.bn[`kind_${kind}`]];
    const appEntries: Entry[] = searchAppSurfaces(installed, needle, canOpen, kindWords).map((hit) => ({
      id: hit.id,
      label: hit.label,
      detail: hit.providerKind ? surfacesT("searchProvider", { kind: surfacesT(`kind_${hit.providerKind}`), app: hit.app }) : surfacesT("searchApp"),
      to: hit.to,
      hash: hit.hash,
      icon: hit.kind === "app" ? Blocks : Plug,
    }));
    return [...navMatches, ...tasks, ...settingEntries, ...appEntries];
  }, [apps, canOpen, goKeys, locale, nav, needle, settingsCard, settingsPage, surfacesT, t, theme, toggleTheme]);

  const records = useMemo<Entry[]>(() => {
    if (!searching) return [];
    const draft = t("draft");
    const discountMatches = discounts.data?.discounts ?? [];
    return [
      ...(orders.data?.orders ?? []).map((order) => ({
        id: `o:${order.id}`,
        label: formatOrderNumber(order.orderNumber, order.id),
        detail: order.customerName,
        to: `/admin/orders/${order.id}`,
        icon: Inbox,
      })),
      ...(customers.data?.customers ?? []).map((customer) => {
        const { title, detail } = customerTitle(customer, customerT);
        return {
          id: `u:${customer.id}`,
          label: title,
          detail: detail ?? undefined,
          to: `/admin/customers/${customer.id}/edit`,
          icon: UserRound,
          titledByPhone: customer.phone !== null && title === formatPhoneForDisplay(customer.phone, getStoreRegion()),
        };
      }),
      ...discountMatches.slice(0, PER_TYPE).map((discount) => ({
        id: `d:${discount.id}`,
        label: discount.codes[0]?.code ?? discount.name,
        detail: t("discounts"),
        to: `/admin/discounts/${discount.id}`,
        icon: BadgePercent,
      })),
      ...(products.data?.products ?? []).map((item) => ({
        id: `p:${item.id}`,
        label: item.name,
        detail: item.isActive ? undefined : draft,
        to: `/admin/products/${item.id}/edit`,
        icon: Tag,
      })),
      ...(collections.data?.collections ?? []).map((item) => ({ id: `l:${item.id}`, label: item.name, detail: t("collections"), to: `/admin/collections/${item.id}/edit`, icon: Layers })),
      ...(categories.data?.categories ?? []).map((item) => ({ id: `c:${item.id}`, label: item.name, detail: t("categories"), to: `/admin/categories/${item.id}/edit`, icon: FolderTree })),
      ...(pages.data?.pages ?? []).map((item) => ({
        id: `g:${item.id}`,
        label: item.title,
        detail: t(item.contentType === "article" ? "blogPosts" : "pages"),
        to: item.contentType === "article" ? `/admin/articles/${item.id}/edit` : `/admin/pages/${item.id}/edit`,
        icon: FileText,
      })),
    ];
  }, [categories.data, collections.data, customers.data, customerT, discounts.data, orders.data, pages.data, products.data, searching, t]);

  const recent = useMemo<Entry[]>(
    () => (open && !term ? readRecent().map((item) => ({ ...item, icon: Clock })) : []),
    [open, term],
  );

  // A page whose name starts with the query wins ("coll" → Collections);
  // then matching records; then other pages. Seven results in total.
  const named = places.filter((entry) => needle && entry.label.toLowerCase().startsWith(needle));
  const matchesAll = [...named, ...records, ...places.filter((entry) => !named.includes(entry))].slice(0, term ? MAX_RESULTS : undefined);
  const recordMatches = matchesAll.filter((entry) => records.includes(entry));
  const placeMatches = matchesAll.filter((entry) => !records.includes(entry));
  const loading = searching && [orders, customers, products, collections, categories, pages].some((result) => result.isFetching) && matchesAll.length === 0;

  const go = (entry: Entry) => {
    remember(entry);
    setOpen(false);
    setQuery("");
    if (entry.run) entry.run();
    else if (entry.to) void navigate({ to: entry.to, hash: entry.hash, search: entry.search as never });
  };

  const renderItem = (entry: Entry) => (
    <CommandItem key={entry.id} value={entry.id} onSelect={() => go(entry)}>
      <entry.icon aria-hidden />
      <span className="flex-1 truncate">
        {entry.label}
        {entry.detail ? <span className="text-muted-foreground"> · {entry.detail}</span> : null}
      </span>
      {entry.hint ? <kbd className="text-caption text-muted-foreground">{entry.hint}</kbd> : null}
    </CommandItem>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <DialogContent variant="palette" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t("search")}</DialogTitle>
        <Command shouldFilter={false} loop>
          <CommandInput value={query} onValueChange={setQuery} placeholder={t("searchPlaceholder")} />
          <CommandList className="max-h-96">
            <CommandEmpty>{loading || term !== lookupTerm ? t("searching") : t("searchNothing")}</CommandEmpty>
            {recent.length ? <CommandGroup heading={t("recent")}>{recent.map(renderItem)}</CommandGroup> : null}
            {named.length ? null : recordMatches.length ? <CommandGroup heading={t("results")}>{recordMatches.map(renderItem)}</CommandGroup> : null}
            {placeMatches.length ? <CommandGroup heading={t("goTo")}>{placeMatches.map(renderItem)}</CommandGroup> : null}
            {named.length && recordMatches.length ? <CommandGroup heading={t("results")}>{recordMatches.map(renderItem)}</CommandGroup> : null}
          </CommandList>
        </Command>
        <p className="hidden border-t px-3 py-2 text-caption text-muted-foreground sm:block">{t("searchHint")}</p>
      </DialogContent>
    </Dialog>
  );
}
