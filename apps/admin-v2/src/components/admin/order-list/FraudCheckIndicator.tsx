import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { getServerFnError } from "@/lib/api-helpers";
import type { FraudLookupData } from "@/lib/api-query-options/fraud-checker";
import { postApiV1AdminFraudCheckerLookup } from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import { formatNumber, useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";

type RiskLevel = NonNullable<FraudLookupData["riskLevel"]>;

function deliveryRate(data: FraudLookupData): number {
  const total = data.total_parcels ?? 0;
  return total > 0 ? ((data.total_delivered ?? 0) / total) * 100 : 0;
}

function riskLevel(data: FraudLookupData): RiskLevel {
  if (data.riskLevel) return data.riskLevel;
  if ((data.total_parcels ?? 0) === 0) return "unknown";
  const rate = deliveryRate(data);
  return rate >= 80 ? "low" : rate >= 50 ? "medium" : "high";
}

/**
 * The customer's courier delivery history (delivered vs cancelled parcels).
 * Without a connected fraud check service (`configured: false`) it says how to connect one.
 */
export function FraudCheckIndicator({ phone, trigger }: { phone: string; trigger: ReactNode }) {
  const t = useMessages(orderListMessages);
  const [open, setOpen] = useState(true);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["fraud-checker", "lookup", phone],
    queryFn: () => apiData(postApiV1AdminFraudCheckerLookup({ body: { phone } })),
    enabled: open,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const notConnected = data?.configured === false;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-body font-medium">{t("deliveryHistory")}</p>
          {!notConnected ? (
            <Button variant="ghost" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : t("refresh")}
            </Button>
          ) : null}
        </div>
        {notConnected ? (
          <p className="text-body text-muted-foreground">
            {t("fraudNotConnected")}{" "}
            <Link to="/admin/settings/apps" className="text-link hover:underline">
              {t("fraudSettingsLink")}
            </Link>
          </p>
        ) : error ? (
          <p className="text-body text-destructive">{getServerFnError(error, t("historyFailed"))}</p>
        ) : !data ? (
          <LoaderCircle className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-2 text-center">
              {([
                ["parcels", data.total_parcels],
                ["delivered", data.total_delivered],
                ["cancelled", data.total_cancel],
              ] as const).map(([key, value]) => (
                <div key={key}>
                  <dt className="text-body text-muted-foreground">{t(key)}</dt>
                  <dd className="text-heading-lg font-semibold">{formatNumber(value ?? 0)}</dd>
                </div>
              ))}
            </dl>
            <div className="space-y-1">
              <div className="flex justify-between text-body">
                <span className="text-muted-foreground">{t("risk")}</span>
                <span className={riskLevel(data) === "high" ? "font-medium text-destructive" : "font-medium"}>
                  {t(`risk.${riskLevel(data)}`)}
                </span>
              </div>
              {(data.total_parcels ?? 0) > 0 ? (
                <>
                  <div className="flex justify-between text-body">
                    <span className="text-muted-foreground">{t("deliveryRate")}</span>
                    <span>{formatNumber(deliveryRate(data), { maximumFractionDigits: 1 })}%</span>
                  </div>
                  <Progress value={deliveryRate(data)} />
                </>
              ) : null}
            </div>
            {data.apis && Object.keys(data.apis).length > 0 ? (
              <ul className="divide-y border-t text-body">
                {Object.entries(data.apis).map(([courier, row]) => (
                  <li key={courier} className="flex justify-between gap-2 py-2">
                    <span className="font-medium">{courier}</span>
                    <span className="text-muted-foreground">
                      {t("courierRow", {
                        delivered: row.total_delivered_parcels,
                        total: row.total_parcels,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
