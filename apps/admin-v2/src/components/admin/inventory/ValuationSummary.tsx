import { ErrorState } from "~/components/admin/states/ErrorState";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { useCurrency } from "~/hooks/use-currency";
import { inventoryValuationQueryOptions } from "~/lib/api-query-options/inventory-costs";
import { useMessages } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";

/**
 * What the stock on hand is worth at current unit costs: the total, each
 * location's share once there are several, units in transit, and how many
 * SKUs have no cost (counted, not valued). Staff only, like every cost.
 */
export function ValuationSummary() {
  const t = useMessages(inventoryMessages);
  const { fmt } = useCurrency();
  const valuation = useQuery(inventoryValuationQueryOptions());
  const data = valuation.data;
  // With one location the total is that location's: no breakdown.
  const locations = data?.locations ?? [];
  const missing = data?.total.skusWithoutCost ?? 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{t("valueTitle")}</CardTitle>
        <CardDescription>{t("valueHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {valuation.isPending ? (
          <Skeleton className="h-7 w-40" />
        ) : !data ? (
          <ErrorState layout="inline" title={t("valueFailed")} error={valuation.error} onRetry={() => void valuation.refetch()} />
        ) : (
          <>
            <div className="space-y-1">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-heading-lg tabular-nums">{fmt(data.total.value)}</span>
                <span className="text-body text-muted-foreground tabular-nums">{t("valueUnits", { count: data.total.units })}</span>
              </p>
              {data.inTransit.units > 0 ? (
                <p className="text-body text-muted-foreground tabular-nums">
                  {t("inTransitValue", { count: data.inTransit.units, value: fmt(data.inTransit.value) })}
                </p>
              ) : null}
            </div>
            {locations.length > 1 ? (
              <dl aria-label={t("valueLocations")} className="divide-y border-t">
                {locations.map((location) => (
                  <div key={location.locationId} className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="min-w-0 truncate text-body">
                      {location.status === "archived" ? t("locationArchived", { name: location.name }) : location.name}
                    </dt>
                    <dd className="shrink-0 text-end text-body tabular-nums">
                      <span className="text-muted-foreground">{t("valueLocationUnits", { count: location.units })}</span>
                      {" · "}
                      {fmt(location.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {missing > 0 ? (
              <p className="text-body text-muted-foreground">
                {missing === 1 ? t("valueMissingCostOne") : t("valueMissingCost", { count: missing })}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
