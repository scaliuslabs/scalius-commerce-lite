import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";

import { MAX_CUSTOMER_SEGMENTS } from "./discount-form";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { formatNumber, useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { customerSegmentsQueryOptions } from "~/lib/api-query-options/customers";

/** The store's saved customer segments by id (a store keeps at most 200). */
export function useSegmentNames(enabled: boolean) {
  const query = useQuery({ ...customerSegmentsQueryOptions(), enabled });
  const segments = query.data?.segments ?? [];
  return { query, segments, names: new Map(segments.map((segment) => [segment.id, segment.name])) };
}

/** "VIP, Dhaka buyers and 1 more"; a segment deleted since it was chosen says so. */
export function useSegmentLabel(names: Map<string, string>): (ids: string[]) => string {
  const t = useMessages(discountsMessages);
  return (ids) => {
    const labels = ids.map((id) => names.get(id) ?? t("segmentDeleted"));
    return labels.length <= 2
      ? labels.join(", ")
      : t("namesMore", { names: labels.slice(0, 2).join(", "), count: labels.length - 2 });
  };
}

/**
 * "Specific customer segments": pick up to five saved segments from a
 * searchable list; the choices show as removable chips, like ScopeField.
 */
export function SegmentField({
  ids,
  onChange,
  error,
  disabled,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
  error?: string;
  disabled?: boolean;
}) {
  const t = useMessages(discountsMessages);
  const { query, segments, names } = useSegmentNames(true);
  const full = ids.length >= MAX_CUSTOMER_SEGMENTS;
  const maxSegments = formatNumber(MAX_CUSTOMER_SEGMENTS);
  const options = segments
    .filter((segment) => !ids.includes(segment.id))
    .map((segment) => ({ value: segment.id, label: segment.name, description: segment.description ?? undefined }));

  return (
    <div className="space-y-3">
      <SearchableSelect
        value=""
        options={options}
        disabled={disabled || full || query.isError}
        busy={query.isPending}
        placeholder={full ? t("segmentsFull", { maxSegments }) : t("addSegment")}
        searchPlaceholder={t("searchSegments")}
        emptyMessage={t(segments.length === 0 ? "noSegments" : "noResults")}
        ariaLabel={t("addSegment")}
        aria-invalid={error ? true : undefined}
        triggerClassName="w-full"
        onValueChange={(value) => {
          if (value && !ids.includes(value) && !full) onChange([...ids, value]);
        }}
      />
      {query.isError ? <p className="text-body text-destructive">{t("loadFailed")}</p> : null}
      {error ? <p className="text-body text-destructive">{error}</p> : null}
      {ids.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {ids.map((id) => {
            const name = names.get(id) ?? (query.isPending ? "…" : t("segmentDeleted"));
            return (
              <li key={id} className="flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-body">
                <span className="max-w-60 truncate">{name}</span>
                {disabled ? null : (
                  <button
                    type="button"
                    className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label={t("remove", { name })}
                    onClick={() => onChange(ids.filter((item) => item !== id))}
                  >
                    <X className="size-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="text-body text-muted-foreground">{t("eligibilitySignInHelp")}</p>
    </div>
  );
}
