import { useMemo, useState, type ComponentType } from "react";
import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, BadgePercent, Clock, FileText, FolderTree, Inbox, Settings, Tag, UserRound } from "lucide-react";
import { getApiV1AdminCustomers, getApiV1AdminOrders, getApiV1AdminSearch } from "@scalius/api-client/sdk";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { apiData } from "~/lib/api";
import { discountsQueryOptions } from "~/lib/api-query-options/discounts";
import { useMessages } from "~/i18n";
import { navKeywordMessages, shellMessages } from "~/i18n/shell";
import { settingsNavMessages } from "~/i18n/settings";
import { settingsSearchMessages } from "~/i18n/settings-search";
import { SETTINGS_NAV } from "../settings/settings-nav";
import { searchSettings } from "../settings/settings-search";
import { GO_SHORTCUTS, type VisibleNavItem } from "./AdminNav";

export interface GlobalSearchProps {
  nav: VisibleNavItem[];
  canOpen: (path: string) => boolean;
}

interface Entry {
  id: string;
  label: string;
  to: string;
  /** A card on a settings page (the settings search's card id). */
  hash?: string;
  icon: ComponentType<{ className?: string }>;
  hint?: string;
  /** Muted second part of the label: the settings page a card is on, a customer's phone. */
  detail?: string;
}

/** Shopify caps admin search at 7 results. */
const MAX_RESULTS = 7;
/** Per record type, so one type can't crowd out the others. */
const PER_TYPE = 3;
const RECENT_KEY = "scalius.search.recent";
const SHORTCUT_BY_PATH = Object.fromEntries(Object.entries(GO_SHORTCUTS).map(([key, to]) => [to, `G ${key.toUpperCase()}`]));

type Recent = Pick<Entry, "id" | "label" | "detail" | "to" | "hash">;

function readRecent(): Recent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** Remembers what was opened on this device: never the typed query, nor a customer's phone. */
function remember(entry: Entry) {
  try {
    const { id, label, to, hash } = entry;
    const detail = id.startsWith("u:") ? undefined : entry.detail;
    const next = [{ id, label, detail, to, hash }, ...readRecent().filter((item) => item.id !== id)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: search still works, only without recents.
  }
}

/**
 * The ⌘K dialog: recently opened places, then for a query the matching
 * dashboard pages and settings (with G-key hints) and the top orders,
 * customers, discounts, products, categories and pages, each opening the
 * record itself. The query stays in this dialog: nothing goes into the URL.
 */
export function GlobalSearchDialog({ nav, canOpen, open, setOpen }: GlobalSearchProps & { open: boolean; setOpen: (open: boolean) => void }) {
  const t = useMessages(shellMessages);
  const keywords = useMessages(navKeywordMessages);
  const settingsPage = useMessages(settingsNavMessages);
  const settingsCard = useMessages(settingsSearchMessages);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const term = query.trim();
  const needle = term.toLowerCase();
  const searching = open && term.length >= 2;
  const lookup = { placeholderData: keepPreviousData, retry: false, staleTime: 30_000 } as const;

  const catalog = useQuery({
    ...lookup,
    queryKey: ["global-search", "catalog", term],
    queryFn: () => apiData(getApiV1AdminSearch({ query: { q: term, limit: PER_TYPE } })),
    enabled: searching && canOpen("/admin/products"),
  });
  const orders = useQuery({
    ...lookup,
    queryKey: ["global-search", "orders", term],
    queryFn: () => apiData(getApiV1AdminOrders({ query: { search: term, limit: PER_TYPE } })),
    enabled: searching && canOpen("/admin/orders"),
  });
  const customers = useQuery({
    ...lookup,
    queryKey: ["global-search", "customers", term],
    queryFn: () => apiData(getApiV1AdminCustomers({ query: { search: term, limit: PER_TYPE } })),
    enabled: searching && canOpen("/admin/customers"),
  });
  // Every discount is one small list the Discounts page caches too; match codes and titles here.
  const discounts = useQuery({ ...discountsQueryOptions(), enabled: searching && canOpen("/admin/discounts") });

  const places = useMemo<Entry[]>(() => {
    const pages = nav.flatMap((item): Entry[] => [
      { id: `nav:${item.key}`, label: t(item.key), to: item.to, icon: ArrowRight, hint: SHORTCUT_BY_PATH[item.to] },
      ...item.children.map((child) => ({ id: `nav:${child.key}`, label: t(child.key), to: child.to, icon: ArrowRight })),
    ]);
    // With no query, offer the sections themselves (their G-key hints teach the shortcuts).
    if (!needle) return pages.filter((entry) => nav.some((item) => `nav:${item.key}` === entry.id));
    // A page matches by its name, then by the words merchants use for it ("menu" → Navigation).
    const byName = pages.filter((entry) => entry.label.toLowerCase().includes(needle));
    const byWord = pages.filter((entry) => {
      const key = entry.id.slice(4) as keyof (typeof navKeywordMessages)["en"];
      return !byName.includes(entry) && key in navKeywordMessages.en && keywords(key).toLowerCase().split(" ").some((word) => word.startsWith(needle));
    });
    // Settings share one index with the settings column's search: pages, then
    // the card a word like "cod", "courier" or "ভ্যাট" belongs to.
    const found = searchSettings(needle);
    const settingsPages = SETTINGS_NAV.filter((item) => canOpen(item.to));
    const settings: Entry[] = [
      ...settingsPages
        .filter((item) => found.pages.includes(item.key))
        .map((item) => ({ id: `set:${item.key}`, label: settingsPage(item.key), to: item.to, icon: Settings })),
      ...found.cards.flatMap((entry): Entry[] => {
        const page = settingsPages.find((item) => item.key === entry.page);
        return page
          ? [{ id: `set:${entry.card}`, label: settingsCard(entry.card), detail: settingsPage(entry.page), to: page.to, hash: entry.card, icon: Settings }]
          : [];
      }),
    ];
    return [...byName, ...settings, ...byWord];
  }, [canOpen, keywords, nav, needle, settingsCard, settingsPage, t]);

  const records = useMemo<Entry[]>(() => {
    if (!searching) return [];
    const found = catalog.data;
    const discountMatches = (discounts.data ?? []).filter((discount) =>
      [discount.name, ...discount.codes.map(({ code }) => code)].some((value) => value.toLowerCase().includes(needle)));
    return [
      ...(orders.data?.orders ?? []).map((order) => ({
        id: `o:${order.id}`,
        label: formatOrderNumber(order.orderNumber, order.id),
        detail: order.customerName,
        to: `/admin/orders/${order.id}`,
        icon: Inbox,
      })),
      ...(customers.data?.customers ?? []).map((customer) => ({
        id: `u:${customer.id}`,
        label: customer.name || formatPhoneForDisplay(customer.phone),
        detail: customer.name ? formatPhoneForDisplay(customer.phone) : undefined,
        to: `/admin/customers/${customer.id}/edit`,
        icon: UserRound,
      })),
      ...discountMatches.slice(0, PER_TYPE).map((discount) => ({
        id: `d:${discount.id}`,
        label: discount.codes[0]?.code ?? discount.name,
        detail: t("discounts"),
        to: `/admin/discounts/${discount.id}`,
        icon: BadgePercent,
      })),
      ...(found?.products ?? []).map((item) => ({ id: `p:${item.id}`, label: item.name, to: `/admin/products/${item.id}/edit`, icon: Tag })),
      ...(found?.categories ?? []).map((item) => ({ id: `c:${item.id}`, label: item.name, to: `/admin/categories/${item.id}/edit`, icon: FolderTree })),
      ...(found?.pages ?? []).map((item) => ({ id: `g:${item.id}`, label: item.title, to: `/admin/pages/${item.id}/edit`, icon: FileText })),
    ];
  }, [catalog.data, customers.data, discounts.data, needle, orders.data, searching, t]);

  const recent = useMemo<Entry[]>(
    () => (open && !term ? readRecent().map((item) => ({ ...item, icon: Clock })) : []),
    [open, term],
  );

  // A page whose name starts with the query wins ("coll" → Collections);
  // then matching records; then other pages. Seven results in total.
  const named = places.filter((entry) => needle && entry.label.toLowerCase().startsWith(needle));
  const matches = [...named, ...records, ...places.filter((entry) => !named.includes(entry))].slice(0, term ? MAX_RESULTS : undefined);
  const recordMatches = matches.filter((entry) => records.includes(entry));
  const placeMatches = matches.filter((entry) => !records.includes(entry));
  const loading = searching && [catalog, orders, customers].some((result) => result.isFetching) && matches.length === 0;

  const go = (entry: Entry) => {
    remember(entry);
    setOpen(false);
    setQuery("");
    void navigate({ to: entry.to, hash: entry.hash });
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
            <CommandEmpty>{loading ? t("searching") : t("searchNothing")}</CommandEmpty>
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

const SHORTCUTS: ReadonlyArray<{ keys: string[]; label: keyof (typeof shellMessages)["en"] }> = [
  { keys: ["S", "⌘/Ctrl K"], label: "shortcutSearch" },
  { keys: ["G H"], label: "home" },
  { keys: ["G O"], label: "orders" },
  { keys: ["G P"], label: "products" },
  { keys: ["G C"], label: "customers" },
  { keys: ["G D"], label: "discounts" },
  { keys: ["G S"], label: "settings" },
  { keys: ["⌘/Ctrl S"], label: "shortcutSave" },
  { keys: ["?"], label: "shortcutHelp" },
];

/** Shopify's `?` sheet: every keyboard shortcut on one card. */
export function ShortcutsDialog({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const t = useMessages(shellMessages);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("shortcutsTitle")}</DialogTitle>
        </DialogHeader>
        <dl className="divide-y text-body">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys.join()} className="flex items-center justify-between gap-4 py-2">
              <dt>{t(shortcut.label)}</dt>
              <dd className="flex items-center gap-1 text-muted-foreground">
                {shortcut.keys.map((key, index) => (
                  <span key={key} className="flex items-center gap-1">
                    {index > 0 ? t("or") : null}
                    <kbd>{key}</kbd>
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-body text-muted-foreground">{t("shortcutsNote")}</p>
      </DialogContent>
    </Dialog>
  );
}
