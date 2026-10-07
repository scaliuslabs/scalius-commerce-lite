import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { MoreHorizontal, UsersRound } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { usePermissions } from "~/contexts/PermissionContext";
import { customerSegmentsQueryOptions, type CustomerSegment } from "~/lib/api-query-options/customers";
import { useMessages } from "~/i18n";
import { customerSegmentMessages } from "~/i18n/customer-segments";
import { resourceMessages } from "~/i18n/resource";
import { DeleteSegmentDialog, SegmentMemberCount, useSegmentExport } from "./segment-actions";

/**
 * Customers → Segments: every saved segment with its live member count and
 * the discounts limited to it. Open one to change it; view its customers,
 * export them or delete it from the row menu.
 */
export function SegmentList() {
  const t = useMessages(customerSegmentMessages);
  const r = useMessages(resourceMessages);
  const navigate = useNavigate();
  const canEdit = usePermissions().hasPermission(PERMISSIONS.CUSTOMERS_EDIT);
  const segments = useQuery(customerSegmentsQueryOptions());
  const exporter = useSegmentExport();
  const [deleting, setDeleting] = useState<CustomerSegment | null>(null);
  const rows = segments.data?.segments ?? [];
  const create = canEdit ? (
    <Button asChild>
      <Link to="/admin/customers/segments/new">{t("createSegment")}</Link>
    </Button>
  ) : null;

  return (
    <div className="pb-8">
      <PageHeader title={t("segments")} actions={rows.length > 0 ? create : null} />
      {segments.isError ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-body">{t("loadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void segments.refetch()}>{t("retry")}</Button>
        </Card>
      ) : segments.isPending ? (
        <Card className="space-y-3 p-4">
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full" />)}
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={UsersRound} title={t("emptyTitle")} description={t("emptyBody")} action={create} help />
        </Card>
      ) : (
        <Card className="overflow-clip">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-pin="primary">{t("segment")}</TableHead>
                <TableHead data-numeric="">{t("customers")}</TableHead>
                <TableHead data-pin="actions"><span className="sr-only">{r("actions")}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((segment) => (
                <TableRow key={segment.id}>
                  <TableCell data-pin="primary">
                    <Link
                      to="/admin/customers/segments/$segmentId"
                      params={{ segmentId: segment.id }}
                      className="line-clamp-2 break-words font-medium text-foreground hover:underline"
                    >
                      {segment.name}
                    </Link>
                    {segment.description ? (
                      <span className="line-clamp-2 break-words text-muted-foreground">{segment.description}</span>
                    ) : null}
                    {segment.promotionCount > 0 ? (
                      <span className="block text-muted-foreground">
                        {segment.promotionCount === 1 ? t("usedByOne") : t("usedBy", { count: segment.promotionCount })}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell data-numeric="">
                    <SegmentMemberCount segmentId={segment.id} />
                  </TableCell>
                  <TableCell data-pin="actions">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={t("actionsFor", { name: segment.name })}>
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => void navigate({ to: "/admin/customers", search: { segmentId: segment.id } as never })}
                        >
                          {t("viewCustomers")}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={exporter.busy !== null} onSelect={() => void exporter.run(segment.id)}>
                          {t("export")}
                        </DropdownMenuItem>
                        {canEdit ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(segment)}>
                              {t("delete")}
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <DeleteSegmentDialog segment={deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }} />
    </div>
  );
}
