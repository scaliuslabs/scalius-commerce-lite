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

/** A warranty select's place while it loads: a field-high skeleton (44px to touch, 36px with a mouse). */
const WARRANTY_FIELD_SKELETON = <Skeleton className="h-11 w-full sm:pointer-fine:h-9" />;

/**
 * The policy list, what stands in the picker's place until it can name one
 * (nothing for the first 300ms, then a skeleton that stays at least 300ms),
 * and, when the list fails to load, its error with Try again to show under a
 * picker that still offers the choices that need no policy ("No warranty",
 * "Same as product"). Names come from the list, so nothing reads
 * "unavailable" before it arrives. `needed` false (a read-only "No warranty"
 * names no policy) shows the value at once.
 */
export function useWarrantyPolicies(needed = true): {
  policies: WarrantyPolicy[];
  placeholder: ReactNode | null;
  failed: boolean;
  failure: ReactNode | null;
} {
  const t = useMessages(warrantyMessages);
  const { data, isPending, isError, error, refetch } = useQuery(warrantyPoliciesQueryOptions(true));
  const waiting = needed && isPending;
  const shown = useShownAfter(waiting);
  const placeholder = shown ? WARRANTY_FIELD_SKELETON : waiting ? <div className="h-11 sm:pointer-fine:h-9" aria-hidden="true" /> : null;
  const failed = needed && isError;
  return {
    policies: data ?? [],
    placeholder,
    failed,
    failure: failed ? <InlineError title={t("loadFailed")} error={error} onRetry={() => void refetch()} /> : null,
  };
}
