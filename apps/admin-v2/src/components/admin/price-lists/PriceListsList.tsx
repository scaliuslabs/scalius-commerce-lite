// Products › Price lists (docs/MARKETS-DESIGN.md D5), Medusa's price lists
// list: each list with its type, market, state, SKU count and schedule. A
// list opens on its own page; a new one starts as a draft.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Tag } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { usePermissions } from "~/contexts/PermissionContext";
import { formatNumber, useMessages } from "~/i18n";
import { priceListMessages, type PriceListMessageKey } from "~/i18n/price-lists";
import { resourceMessages } from "~/i18n/resource";
import { formatAdminTimestamp } from "~/lib/admin-time";
import { priceListsQueryOptions, type PriceList } from "~/lib/api-query-options/price-lists";
import { CreatePriceListDialog } from "./CreatePriceListDialog";
import { KIND_LABEL } from "./price-list-form";

type Messages = (key: PriceListMessageKey, vars?: Record<string, string | number>) => string;

/** "Always", "From …", "Until …" or "… to …", in store time. */
export function scheduleText(list: Pick<PriceList, "startsAt" | "endsAt">, t: Messages): string {
  const start = formatAdminTimestamp(list.startsAt);
  const end = formatAdminTimestamp(list.endsAt);
  if (start && end) return t("betweenDates", { start, end });
  if (start) return t("fromDate", { date: start });
  if (end) return t("untilDate", { date: end });
  return t("always");
}

export function PriceListsList() {
  const t = useMessages(priceListMessages);
  const r = useMessages(resourceMessages);
  const canEdit = usePermissions().hasPermission(PERMISSIONS.PRODUCTS_EDIT);
  const lists = useQuery(priceListsQueryOptions());
  const [creating, setCreating] = useState(false);
  const rows = lists.data ?? [];
  const create = canEdit ? <Button onClick={() => setCreating(true)}>{t("create")}</Button> : null;

  return (
    <div className="pb-8">
      <PageHeader title={t("pageTitle")} actions={rows.length > 0 ? create : null} />
      <p className="mb-4 max-w-3xl text-body text-muted-foreground">{t("pageDescription")}</p>
      {lists.isError ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-body">{t("loadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void lists.refetch()}>{r("retry")}</Button>
        </Card>
      ) : lists.isPending ? (
        <Card className="space-y-3 p-4">
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full" />)}
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={Tag} title={t("emptyTitle")} description={t("emptyBody")} action={create} />
        </Card>
      ) : (
        <Card className="overflow-clip">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-pin="primary">{t("columnName")}</TableHead>
                <TableHead>{t("columnStatus")}</TableHead>
                <TableHead>{t("columnType")}</TableHead>
                <TableHead data-numeric="">{t("columnPrices")}</TableHead>
                <TableHead>{t("columnSchedule")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((list) => (
                <TableRow key={list.id}>
                  <TableCell data-pin="primary">
                    <Link
                      to="/admin/price-lists/$priceListId"
                      params={{ priceListId: list.id }}
                      className="line-clamp-2 break-words font-medium text-foreground hover:underline"
                    >
                      {list.name}
                    </Link>
                    {list.description ? <span className="line-clamp-1 break-words text-muted-foreground">{list.description}</span> : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={list.state}>{t(list.state)}</StatusBadge>
                  </TableCell>
                  <TableCell>
                    <span className="block">{t(KIND_LABEL[list.kind])}</span>
                    <span className="block text-muted-foreground">
                      {list.kind === "segment" && list.segmentName
                        ? t("segmentOf", { segment: list.segmentName, market: list.marketName })
                        : list.marketName}
                    </span>
                  </TableCell>
                  <TableCell data-numeric="">{formatNumber(list.variantCount)}</TableCell>
                  <TableCell>{scheduleText(list, t)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {canEdit ? <CreatePriceListDialog open={creating} onOpenChange={setCreating} /> : null}
    </div>
  );
}
