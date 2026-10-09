import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "~/lib/toast";

import { DiscountStatusBadge } from "./DiscountStatusBadge";
import { describeValue, discountTypeOf, draftFromDiscount, type SummaryFormat } from "./discount-form";
import { useScopeLabel } from "./ScopeField";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { sortHeader } from "~/components/admin/resource/columns";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { useCurrency } from "~/hooks/use-currency";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { discountsMessages, type DiscountMessageKey } from "~/i18n/discounts";
import { discountFailureText, useDeleteDiscount, useSetDiscountActive } from "~/lib/api-mutations/discounts";
import type { DiscountListItem, DiscountRecord } from "~/lib/api-query-options/discounts";

/** A discount's name in the list: its first code, or its title for an automatic discount. */
export const discountTitle = (discount: Pick<DiscountRecord, "codes" | "name">) => discount.codes[0]?.code ?? discount.name;

function datesLabel(discount: DiscountListItem, t: (key: DiscountMessageKey, vars?: Record<string, string | number>) => string) {
  const date = (epoch: number) => formatDateTime(new Date(epoch * 1_000), { dateStyle: "medium" });
  if (discount.startsAtEpochSeconds === null) return "—";
  return discount.endsAtEpochSeconds === null
    ? t("datesFrom", { start: date(discount.startsAtEpochSeconds) })
    : t("datesBetween", { start: date(discount.startsAtEpochSeconds), end: date(discount.endsAtEpochSeconds) });
}

/** The discounts index's columns (Shopify: title with its value, status, method, type, used, dates). */
export function useDiscountColumns(): ColumnDef<DiscountListItem, unknown>[] {
  const t = useMessages(discountsMessages);
  const { code: currencyCode, fmt } = useCurrency();
  const scopeLabel = useScopeLabel();
  const format: SummaryFormat = {
    money: (major) => fmt(Number(major)),
    number: (value) => formatNumber(Number(value)),
    date: () => "",
    scope: (scope) => scopeLabel(scope, new Map()),
  };
  const valueOf = (discount: DiscountListItem) => {
    const { key, vars } = describeValue(draftFromDiscount(discount, currencyCode), currencyCode, format);
    return t(key, vars);
  };
  return [
    {
      id: "title",
      // Sorted on the server by name (the column needs a value to be sortable).
      accessorFn: (row) => discountTitle(row),
      header: sortHeader(t("columnTitle")),
      meta: { primary: true, minWidth: 220, maxWidth: 360 },
      cell: ({ row }) => {
        const discount = row.original;
        const title = discountTitle(discount);
        const value = valueOf(discount);
        const more = discount.codeCount > 1 ? t("moreCodes", { count: discount.codeCount - 1 }) : null;
        return (
          <span className="block min-w-0">
            <Link
              to="/admin/discounts/$discountId"
              params={{ discountId: discount.id }}
              title={title}
              className="block truncate font-medium text-foreground hover:underline"
            >
              {discount.method === "code" ? <span className="font-mono">{title}</span> : title}
            </Link>
            <span title={more ? `${value} · ${more}` : value} className="block truncate text-muted-foreground">
              {value}{more ? ` · ${more}` : null}
            </span>
          </span>
        );
      },
    },
    {
      id: "status",
      header: t("columnStatus"),
      enableSorting: false,
      meta: { mobile: "status", priority: 90, minWidth: 110 },
      cell: ({ row }) => <DiscountStatusBadge discount={row.original} />,
    },
    {
      id: "method",
      header: t("columnMethod"),
      enableSorting: false,
      meta: { priority: 30, minWidth: 100 },
      cell: ({ row }) => <span className="whitespace-nowrap">{t(row.original.method === "code" ? "methodCode" : "methodAutomatic")}</span>,
    },
    {
      id: "type",
      header: t("columnType"),
      enableSorting: false,
      meta: { priority: 40, minWidth: 150 },
      cell: ({ row }) => <span className="block truncate" title={t(`type_${discountTypeOf(row.original)}`)}>{t(`type_${discountTypeOf(row.original)}`)}</span>,
    },
    {
      id: "dates",
      header: t("columnDates"),
      enableSorting: false,
      meta: { priority: 50, minWidth: 180 },
      cell: ({ row }) => <span className="whitespace-nowrap">{datesLabel(row.original, t)}</span>,
    },
    {
      id: "used",
      header: t("columnUsed"),
      enableSorting: false,
      meta: { numeric: true, mobile: "secondary", priority: 70, minWidth: 80 },
      cell: ({ row }) => (
        <>
          {formatNumber(row.original.redemptionCount)}
          {row.original.maxRedemptions !== null ? ` / ${formatNumber(row.original.maxRedemptions)}` : null}
        </>
      ),
    },
  ];
}

type BulkAction = "activate" | "deactivate" | "delete";

/**
 * The discounts list's bulk actions on the ticked rows (a page at most): each
 * discount is changed with its own revision, then one summary names what
 * failed and why.
 */
export function DiscountBulkActions({ rows, done, canToggle, canDelete }: {
  rows: DiscountListItem[];
  done: () => void;
  canToggle: boolean;
  canDelete: boolean;
}) {
  const t = useMessages(discountsMessages);
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const activeMutation = useSetDiscountActive();
  const deleteMutation = useDeleteDiscount();
  const toActivate = rows.filter((discount) => discount.status !== "active" && discount.status !== "archived");
  const toDeactivate = rows.filter((discount) => discount.status === "active");

  async function runBulk(action: BulkAction, targets: DiscountListItem[]) {
    setBusy(action);
    const failed: string[] = [];
    for (const discount of targets) {
      try {
        if (action === "delete") {
          await deleteMutation.mutateAsync({ id: discount.id, expectedRevision: discount.revision });
        } else {
          await activeMutation.mutateAsync({ id: discount.id, expectedRevision: discount.revision, active: action === "activate" });
        }
      } catch (error) {
        failed.push(`${discountTitle(discount)}: ${discountFailureText(error)}`);
      }
    }
    setBusy(null);
    setConfirming(false);
    done();
    const succeeded = targets.length - failed.length;
    const verb = action === "delete" ? "Deleted" : action === "activate" ? "Activated" : "Deactivated";
    if (failed.length === 0) {
      toast.success(succeeded === 1 ? t(`toast${verb}`) : t(`bulk${verb}`, { count: succeeded }));
    } else {
      toast.error(t(`bulkPartly${verb}`, { done: formatNumber(succeeded), count: targets.length }), {
        description: <ul>{failed.map((line) => <li key={line}>{line}</li>)}</ul>,
        duration: 10_000,
      });
    }
  }

  return (
    <>
      {canToggle && toActivate.length > 0 ? (
        <Button type="button" variant="outline" disabled={busy !== null} loading={busy === "activate"} onClick={() => void runBulk("activate", toActivate)}>
          {t("activate")}
        </Button>
      ) : null}
      {canToggle && toDeactivate.length > 0 ? (
        <Button type="button" variant="outline" disabled={busy !== null} loading={busy === "deactivate"} onClick={() => void runBulk("deactivate", toDeactivate)}>
          {t("deactivate")}
        </Button>
      ) : null}
      {canDelete ? (
        <Button type="button" variant="destructive" disabled={busy !== null} onClick={() => setConfirming(true)}>
          {t(rows.length === 1 ? "delete" : "bulkDelete")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirming(false);
        }}
        title={rows.length === 1
          ? t("deleteTitle", { name: discountTitle(rows[0]!) })
          : t("bulkDeleteTitle", { count: rows.length })}
        description={t(rows.length === 1 ? "deleteBody" : "bulkDeleteBody")}
        confirmLabel={t(rows.length === 1 ? "delete" : "bulkDelete")}
        cancelLabel={t("cancel")}
        isLoading={busy === "delete"}
        onConfirm={() => void runBulk("delete", rows)}
      />
    </>
  );
}
