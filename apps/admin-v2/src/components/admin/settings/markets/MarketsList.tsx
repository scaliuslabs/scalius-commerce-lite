// Settings › Markets (docs/MARKETS-DESIGN.md D4), Shopify's markets list:
// each market with its status, countries, currency and web presence, the
// backup market first and labelled. A market opens on its own page.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { settingsMarketsMessages } from "~/i18n/settings-markets";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import { SettingsCard, SettingsCardLoading } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { CreateMarketDialog } from "./CreateMarketDialog";
import { countryName } from "./MarketCountryPicker";
import { countriesTakenByOthers, marketPresencePath } from "./market-form";

export function MarketsList() {
  const t = useMessages(settingsMarketsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const { data, isError, refetch } = useQuery(marketsQueryOptions());
  const [creating, setCreating] = useState(false);

  if (isError) return <SettingsLoadFailure title={t("loadFailed")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;

  return (
    <>
      <SettingsCard
        title={t("title")}
        description={t("description")}
        action={canEdit ? <Button type="button" size="sm" onClick={() => setCreating(true)}>{t("add")}</Button> : null}
        rows={
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-pin="primary">{t("market")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{t("countries")}</TableHead>
                <TableHead>{t("currency")}</TableHead>
                <TableHead>{t("webPresence")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((market) => {
                const path = marketPresencePath(market);
                return (
                  <TableRow key={market.id}>
                    <TableCell data-pin="primary">
                      <span className="flex flex-wrap items-center gap-2">
                        <Link
                          to="/admin/settings/markets/$marketId"
                          params={{ marketId: market.id }}
                          className="break-words font-medium text-foreground hover:underline"
                        >
                          {market.name}
                        </Link>
                        {market.isBackup ? <Badge variant="info">{t("backup")}</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={market.status}>{t(market.status)}</StatusBadge>
                    </TableCell>
                    <TableCell>
                      <span className="line-clamp-2 min-w-40 break-words">
                        {market.countries.length > 0 ? market.countries.map(countryName).join(", ") : t("noCountries")}
                      </span>
                    </TableCell>
                    <TableCell>{market.currencyCode}</TableCell>
                    <TableCell>
                      {path ? <code>{path}</code> : <span className="text-muted-foreground">{t("none")}</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        }
      />
      <CreateMarketDialog open={creating} onOpenChange={setCreating} taken={countriesTakenByOthers(data, null)} />
    </>
  );
}
