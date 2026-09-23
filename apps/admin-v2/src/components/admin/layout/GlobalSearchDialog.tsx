import { useMemo, useState, type ComponentType } from "react";
import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, Clock, FileText, FolderTree, Inbox, Settings, Tag, UserRound } from "lucide-react";
import { getApiV1AdminSearch } from "@scalius/api-client/sdk";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { apiData } from "~/lib/api";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
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
  search?: Record<string, string>;
  /** A card on a settings page (the settings search's card id). */
  hash?: string;
  icon: ComponentType<{ className?: string }>;
  hint?: string;
  /** Muted second part of the label, e.g. the settings page a card is on. */
  detail?: string;
}

/** Shopify caps admin search at 7 results. */
const MAX_RESULTS = 7;
const RECENT_KEY = "scalius.search.recent";
const SHORTCUT_BY_PATH = Object.fromEntries(Object.entries(GO_SHORTCUTS).map(([key, to]) => [to, `G ${key.toUpperCase()}`]));

function readRecent(): Array<Pick<Entry, "id" | "label" | "to" | "search">> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function remember(entry: Entry) {
  try {
    // Record ids, names and paths only; search terms never go to storage.
    if (entry.search) return;
    const next = [{ id: entry.id, label: entry.label, to: entry.to }, ...readRecent().filter((item) => item.id !== entry.id)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: search still works, only without recents.
  }
}

/**
 * The ⌘K dialog: recent places, dashboard pages and settings (with G-key
 * hints), matching orders/customers, and catalogue records. Always mounted
 * and driven by `open`.
 */
export function GlobalSearchDialog({ nav, canOpen, open, setOpen }: GlobalSearchProps & { open: boolean; setOpen: (open: boolean) => void }) {
  const t = useMessages(shellMessages);
  const settingsPage = useMessages(settingsNavMessages);
  const settingsCard = useMessages(settingsSearchMessages);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const term = query.trim();
  const needle = term.toLowerCase();

  const { data } = useQuery({
    queryKey: ["global-search", term],
    queryFn: () => apiData(getApiV1AdminSearch({ query: { q: term, limit: MAX_RESULTS } })),
    enabled: open && term.length >= 2,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });

  const places = useMemo<Entry[]>(() => {
    const pages = nav.flatMap((item): Entry[] => [
      { id: `nav:${item.to}`, label: t(item.key), to: item.to, icon: ArrowRight, hint: SHORTCUT_BY_PATH[item.to] },
      ...item.children
        .filter((child) => child.to !== item.to)
        .map((child) => ({ id: `nav:${child.to}`, label: t(child.key), to: child.to, icon: ArrowRight })),
    ]);
    // With no query, offer the sections themselves (their G-key hints teach the shortcuts).
    if (!needle) return pages.filter((entry) => nav.some((item) => item.to === entry.to));
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
    return [...pages.filter((entry) => entry.label.toLowerCase().includes(needle)), ...settings];
  }, [canOpen, nav, needle, settingsCard, settingsPage, t]);

  const records = useMemo<Entry[]>(() => {
    if (term.length < 2) return [];
    const results = data;
    return [
      ...(canOpen("/admin/orders") ? [{ id: "q:orders", label: t("ordersMatching", { q: term }), to: "/admin/orders", search: { search: term }, icon: Inbox }] : []),
      ...(canOpen("/admin/customers") ? [{ id: "q:customers", label: t("customersMatching", { q: term }), to: "/admin/customers", search: { search: term }, icon: UserRound }] : []),
      ...(results?.products ?? []).map((item) => ({ id: `p:${item.id}`, label: item.name, to: `/admin/products/${item.id}/edit`, icon: Tag })),
      ...(results?.categories ?? []).map((item) => ({ id: `c:${item.id}`, label: item.name, to: `/admin/categories/${item.id}/edit`, icon: FolderTree })),
      ...(results?.pages ?? []).map((item) => ({ id: `g:${item.id}`, label: item.title, to: `/admin/pages/${item.id}/edit`, icon: FileText })),
    ];
  }, [canOpen, data, t, term]);

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

  const go = (entry: Entry) => {
    remember(entry);
    setOpen(false);
    setQuery("");
    void navigate({ to: entry.to, search: entry.search as never, hash: entry.hash });
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
      {/* Drops from the top bar like Shopify's search (top of the screen on
          phones, where the keyboard takes the bottom), same 12px radius. */}
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 max-sm:bottom-auto max-sm:pb-0 max-sm:top-0 max-sm:rounded-b-2xl max-sm:rounded-t-none sm:top-2.5 sm:max-w-160 sm:translate-y-0 sm:rounded-xl"
      >
        <DialogTitle className="sr-only">{t("search")}</DialogTitle>
        <Command shouldFilter={false} loop>
          <CommandInput value={query} onValueChange={setQuery} placeholder={t("searchPlaceholder")} />
          <CommandList className="max-h-96">
            <CommandEmpty>{t("searchNothing")}</CommandEmpty>
            {recent.length ? <CommandGroup heading={t("recent")}>{recent.map(renderItem)}</CommandGroup> : null}
            {named.length ? null : recordMatches.length ? <CommandGroup heading={t("search")}>{recordMatches.map(renderItem)}</CommandGroup> : null}
            {placeMatches.length ? <CommandGroup heading={t("goTo")}>{placeMatches.map(renderItem)}</CommandGroup> : null}
            {named.length && recordMatches.length ? <CommandGroup heading={t("search")}>{recordMatches.map(renderItem)}</CommandGroup> : null}
          </CommandList>
        </Command>
        <p className="hidden border-t px-3 py-2 text-caption text-muted-foreground sm:block">{t("searchHint")}</p>
      </DialogContent>
    </Dialog>
  );
}
