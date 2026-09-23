import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { FileText, FolderTree, Inbox, Tag, UserRound } from "lucide-react";
import { getApiV1AdminSearch } from "@scalius/api-client/sdk";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { apiData } from "~/lib/api";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import type { VisibleNavItem } from "./AdminNav";

export interface GlobalSearchProps {
  nav: VisibleNavItem[];
  canOpen: (path: string) => boolean;
}

/** The ⌘K search dialog: dashboard pages, catalogue matches and list searches. */
export function GlobalSearchDialog({ nav, canOpen, open, setOpen }: GlobalSearchProps & { open: boolean; setOpen: (open: boolean) => void }) {
  const t = useMessages(shellMessages);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const term = query.trim();

  const { data } = useQuery({
    queryKey: ["global-search", term],
    queryFn: () => apiData(getApiV1AdminSearch({ query: { q: term, limit: 5 } })),
    enabled: open && term.length >= 2,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });

  const destinations = useMemo(() => {
    const links = nav.flatMap((item) => [
      { key: item.key, to: item.to },
      ...item.children.filter((child) => child.to !== item.to),
    ]);
    const needle = term.toLowerCase();
    return links.filter((link) => !needle || t(link.key).toLowerCase().includes(needle));
  }, [nav, t, term]);

  const go = (to: string, search?: Record<string, string>) => {
    setOpen(false);
    setQuery("");
    void navigate({ to, search: search as never });
  };

  const results = term.length >= 2 ? data : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">{t("search")}</DialogTitle>
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={t("searchPlaceholder")} />
          <CommandList className="max-h-96">
            <CommandEmpty>{t("searchNothing")}</CommandEmpty>
            {term.length >= 2 ? (
              <CommandGroup>
                {canOpen("/admin/orders") ? (
                  <CommandItem value="orders-search" onSelect={() => go("/admin/orders", { search: term })}>
                    <Inbox /> {t("ordersMatching", { q: term })}
                  </CommandItem>
                ) : null}
                {canOpen("/admin/customers") ? (
                  <CommandItem value="customers-search" onSelect={() => go("/admin/customers", { search: term })}>
                    <UserRound /> {t("customersMatching", { q: term })}
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
            {results?.products.length ? (
              <CommandGroup heading={t("products")}>
                {results.products.map((product) => (
                  <CommandItem key={product.id} value={`p-${product.id}`} onSelect={() => go(`/admin/products/${product.id}/edit`)}>
                    <Tag /> <span className="truncate">{product.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {results?.categories.length ? (
              <CommandGroup heading={t("categories")}>
                {results.categories.map((category) => (
                  <CommandItem key={category.id} value={`c-${category.id}`} onSelect={() => go(`/admin/categories/${category.id}/edit`)}>
                    <FolderTree /> <span className="truncate">{category.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {results?.pages.length ? (
              <CommandGroup heading={t("pages")}>
                {results.pages.map((page) => (
                  <CommandItem key={page.id} value={`g-${page.id}`} onSelect={() => go(`/admin/pages/${page.id}/edit`)}>
                    <FileText /> <span className="truncate">{page.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {destinations.length ? (
              <CommandGroup heading={t("goTo")}>
                {destinations.map((link) => (
                  <CommandItem key={link.to} value={`nav-${link.to}`} onSelect={() => go(link.to)}>
                    {t(link.key)}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
