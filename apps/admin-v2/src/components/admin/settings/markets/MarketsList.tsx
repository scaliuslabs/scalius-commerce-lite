// Settings › Markets (docs/MARKETS-DESIGN.md D4), Shopify's markets page. A
// store with one market sees a sentence about it (where it sells, in what
// currency and language) and one way to grow: "Sell in another country". The
// table, with each market's status, countries and currency, appears once a
// second market exists; the web address column only when a market has one.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatList } from "@scalius/shared/locale-words";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { useHasPermission } from "~/contexts/PermissionContext";
import { getLocale, useMessages } from "~/i18n";
import { settingsMarketsMessages } from "~/i18n/settings-markets";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { marketsQueryOptions, type Market } from "~/lib/api-query-options/markets";
import { languageName } from "../../translations/translation-form";
import { SettingsCard, SettingsCardLoading } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { CreateMarketDialog } from "./CreateMarketDialog";
import { countryName } from "./MarketCountryPicker";
import { countriesTakenByOthers, marketPresencePath } from "./market-form";

function PrimaryBadge() {
  const t = useMessages(settingsMarketsMessages);
  return <Badge variant="info">{t("primary")}</Badge>;
}

/** The one-market view: where it sells, in what currency and language. */
function SoleMarket({ market }: { market: Market }) {
  const t = useMessages(settingsMarketsMessages);
  const locale = getLocale();
  const vars = {
    currency: market.currencyCode,
    language: languageName(market.presence?.locale ?? locale, locale),
  };
  return (
    <div className="space-y-1 px-4 py-3">
      <p className="flex flex-wrap items-center gap-2">
        <Link
          to="/admin/settings/markets/$marketId"
          params={{ marketId: market.id }}
          aria-label={t("edit", { name: market.name })}
          className="break-words text-body font-medium text-foreground hover:underline"
        >
          {market.name}
        </Link>
        <PrimaryBadge />
      </p>
      <p className="text-body text-muted-foreground">
        {market.countries.length > 0
          ? t("soleSummary", { ...vars, countries: formatList(market.countries.map(countryName), locale) })
          : t("soleSummaryEverywhere", vars)}
      </p>
      <p className="text-body text-muted-foreground">{t("sellElsewhereHelp")}</p>
    </div>
  );
}

export function MarketsList() {
  const t = useMessages(settingsMarketsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const { data, isError, refetch } = useQuery(marketsQueryOptions());
  const [creating, setCreating] = useState(false);

  if (isError) return <SettingsLoadFailure title={t("loadFailed")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;

  const sole = data.length === 1 ? data[0]! : null;
  const showAddress = data.some((market) => !market.isBackup && marketPresencePath(market));
  return (
    <>
      <SettingsCard
        title={t("title")}
        description={sole ? t("description") : t("descriptionMany")}
        action={canEdit ? <Button type="button" size="sm" onClick={() => setCreating(true)}>{sole ? t("sellElsewhere") : t("add")}</Button> : null}
        rows={
          sole ? (
            <SoleMarket market={sole} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead data-pin="primary">{t("market")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("countries")}</TableHead>
                  <TableHead>{t("currency")}</TableHead>
                  {showAddress ? <TableHead>{t("webAddress")}</TableHead> : null}
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
                          {market.isBackup ? <PrimaryBadge /> : null}
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
                      {showAddress ? (
                        <TableCell>
                          {market.isBackup || !path ? <span className="text-muted-foreground">—</span> : <code>{path}</code>}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )
        }
      />
      {sole ? null : (
        <p className="px-1 text-body text-muted-foreground">
          {t("priceListsHint")} <Link to="/admin/price-lists" className="text-link hover:underline">{t("priceListsLink")}</Link>.
        </p>
      )}
      <CreateMarketDialog open={creating} onOpenChange={setCreating} taken={countriesTakenByOthers(data, null)} />
    </>
  );
}
