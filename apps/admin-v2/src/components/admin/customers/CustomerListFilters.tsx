import { lazy, Suspense, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { Skeleton } from "~/components/ui/skeleton";
import { useAppResourceColumns } from "~/components/admin/apps/ui/list-columns";
import { fetchCustomerTags, customerSegmentsQueryOptions } from "~/lib/api-query-options/customers";
import { queryKeys } from "~/lib/query-keys";
import { NO_CURSOR } from "~/lib/list-helpers";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { CUSTOMER_CHANNELS, type CustomerChannel, type CustomerListSearch } from "./customer-list-search";

const TRIGGER = "w-full shrink-0 sm:w-auto sm:min-w-40";

// Loads only when an active app has a column to filter by.
const AppListFilter = lazy(() => import("~/components/admin/apps/AppListFilter").then((module) => ({ default: module.AppListFilter })));

/**
 * The customers list's filters: a tag (searched on the server), a saved
 * segment and, on the Subscribers tab, one channel. Each choice goes in the
 * page URL; what is typed to find a tag never does.
 */
export function CustomerListFilters({ search }: { search: CustomerListSearch }) {
  const t = useMessages(customersMessages);
  const navigate = useNavigate();
  const segments = useQuery(customerSegmentsQueryOptions());
  const { all: appColumns } = useAppResourceColumns("customer");
  const appFilterable = appColumns.some((column) => column.filterable);
  const set = (updates: Partial<Record<"tag" | "segmentId" | "channel" | "appFilter", string | undefined>>) =>
    void navigate({
      to: "/admin/customers",
      search: ((prev: Record<string, unknown>) => ({ ...prev, ...updates, page: 1, ...NO_CURSOR })) as never,
    });

  const loadTags = useCallback<SearchableSelectLoader>(async ({ search: typed, signal }) => {
    const { tags } = await fetchCustomerTags(typed, 50, signal);
    return {
      options: tags.map((entry) => ({
        value: entry.tag,
        label: entry.tag,
        description: entry.customers === 1 ? t("tagCustomersOne") : t("tagCustomers", { count: entry.customers }),
      })),
      hasMore: false,
    };
  }, [t]);

  return (
    <>
      {search.view === "subscribers" ? (
        <SearchableSelect
          value={search.channel ?? "any"}
          onValueChange={(value) => set({ channel: value === "any" ? undefined : value })}
          options={[
            { value: "any", label: t("anyChannel") },
            ...CUSTOMER_CHANNELS.map((channel: CustomerChannel) => ({ value: channel, label: t(`channel.${channel}`) })),
          ]}
          placeholder={t("anyChannel")}
          searchPlaceholder={t("filterChannel")}
          ariaLabel={t("filterChannel")}
          triggerClassName={TRIGGER}
        />
      ) : null}
      <SearchableSelect
        value={search.tag ?? ""}
        selectedLabel={search.tag}
        onValueChange={(value) => set({ tag: value || undefined })}
        load={loadTags}
        queryKey={[...queryKeys.customers.tags(), "filter"]}
        placeholder={t("anyTag")}
        searchPlaceholder={t("searchTags")}
        emptyMessage={t("noTagsFound")}
        ariaLabel={t("filterTag")}
        clearable
        triggerClassName={TRIGGER}
      />
      <SearchableSelect
        value={search.segmentId ?? ""}
        onValueChange={(value) => set({ segmentId: value || undefined })}
        options={(segments.data?.segments ?? []).map((segment) => ({ value: segment.id, label: segment.name }))}
        placeholder={t("anySegment")}
        searchPlaceholder={t("searchSegments")}
        emptyMessage={t("noSegments")}
        ariaLabel={t("filterSegment")}
        busy={segments.isPending}
        clearable
        triggerClassName={TRIGGER}
      />
      {appFilterable ? (
        <Suspense fallback={<Skeleton className="h-9 w-full sm:w-80" />}>
          <AppListFilter resource="customer" value={search.appFilter} onChange={(appFilter) => set({ appFilter })} />
        </Suspense>
      ) : null}
    </>
  );
}
