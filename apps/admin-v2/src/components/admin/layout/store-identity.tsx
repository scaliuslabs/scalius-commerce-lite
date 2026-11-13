import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";

/**
 * The store's public name and its storefront host, one read every signed-in
 * staff member may make (the name is on every storefront page, so it is not
 * a settings secret). An unnamed store has no name here: callers ask for one
 * (staff who may open Store details) or show the host, never "Scalius".
 */
export function useStoreIdentity() {
  const { hasPermission } = usePermissions();
  const storefront = useQuery(storefrontUrlQueryOptions());
  const data = storefront.data as { storefrontUrl?: string; storeName?: string } | undefined;
  const url = data?.storefrontUrl ?? "";
  return {
    /** May open Store details (where the name is set). */
    canView: hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW),
    loaded: Boolean(data),
    /** The read has answered. */
    settled: storefront.isFetched,
    name: data?.storeName?.trim() ?? "",
    host: url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  };
}

/** "name\nhost": plain text, so a damaged copy can only paint wrong text, once. */
const REMEMBERED_KEY = "scalius.store.shown";

/**
 * The store's name and host for the top bar. Until both reads answer, the
 * ones this browser last showed, so the bar's store button keeps its width
 * and nothing beside it moves when they arrive (with nothing remembered,
 * nothing: the host and then the name would move it twice). The remembered
 * copy is only ever a first paint: the reads replace it, nothing else reads it.
 */
export function useShownStoreIdentity() {
  const store = useStoreIdentity();
  const [previous] = useState(() => {
    try {
      return localStorage.getItem(REMEMBERED_KEY)?.split("\n") ?? [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      if (store.settled) localStorage.setItem(REMEMBERED_KEY, `${store.name}\n${store.host}`);
    } catch {
      // Private mode: the next load paints without it.
    }
  }, [store.settled, store.name, store.host]);
  return store.settled ? store : { ...store, name: previous[0] ?? "", host: previous[1] ?? "" };
}

/** Shopify's store avatar: a coloured square with the name's first character. */
export function StoreBadge({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden data-initial={name ? Array.from(name)[0]!.toUpperCase() : undefined} className={cn("grid size-5 shrink-0 place-items-center rounded-md bg-store-badge text-caption font-semibold text-store-badge-foreground data-[initial]:before:content-[attr(data-initial)]", className)}>
      {name ? null : <Store className="size-3.5" />}
    </span>
  );
}
