// The warranty policies a picker chooses from: the product's Warranty card
// and a variant's warranty field load them the same way (L3, R3).
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useShownAfter } from "@/components/admin/data-table/use-shown-after";
import { useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";
import { InlineError } from "../states/InlineError";
import { warrantyPoliciesQueryOptions, type WarrantyPolicy } from "./warranty-api";

/**
 * The policy list, or what stands in the picker's place until it can name
 * one: nothing for the first 300ms, then a skeleton that stays at least
 * 300ms, and a failed read with Retry. Names come from the list, so nothing
 * reads "unavailable" before it arrives. `needed` false (a read-only "No
 * warranty" names no policy) shows the value at once.
 */
export function useWarrantyPolicies(needed = true): { policies: WarrantyPolicy[]; placeholder: ReactNode | null } {
  const t = useMessages(warrantyMessages);
  const { data, isPending, isError, error, refetch } = useQuery(warrantyPoliciesQueryOptions(true));
  const waiting = needed && isPending;
  const shown = useShownAfter(waiting);
  if (shown) return { policies: [], placeholder: <Skeleton className="h-9 w-full" /> };
  if (waiting) return { policies: [], placeholder: <div className="h-9" aria-hidden="true" /> };
  if (needed && isError) {
    return { policies: [], placeholder: <InlineError title={t("loadFailed")} error={error} onRetry={() => void refetch()} /> };
  }
  return { policies: data ?? [], placeholder: null };
}
