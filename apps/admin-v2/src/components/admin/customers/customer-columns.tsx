import type { CustomersListPayload } from "~/lib/api-query-options/customers";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { createDateColumn } from "~/components/admin/data-table/columns/column-factories";
import { localeWidth } from "~/components/admin/data-table/column-layout";
import { sortHeader } from "~/components/admin/resource/columns";
import { CustomerCell } from "~/components/admin/CustomerCell";
import type { customersMessages } from "~/i18n/customers";

export type CustomerListItem = CustomersListPayload["customers"][number];

type Translate = (key: keyof (typeof customersMessages)["en"], vars?: Record<string, string | number>) => string;

/**
 * Each column's layout: `minWidth` is the widest its content gets in the
 * dashboard's language plus the cell's 6px each side (`list-layout.test.tsx` measures
 * it); the name is cut at `maxWidth`, whole on hover.
 */
export const CUSTOMER_COLUMN_LAYOUT = {
  name: { mobile: "primary", maxWidth: 240, minWidth: 252 },
  totalOrders: { mobile: "secondary", numeric: true, priority: 60, minWidth: { en: 120, bn: 140 } },
  totalSpent: { mobile: "secondary", numeric: true, priority: 80, minWidth: 120 },
} as const;

/**
 * The customers list: the customer (name over phone, two lines on every
 * row), orders, amount paid and the last order, then any data-backed
 * columns `extra` (apps' fields).
 */
export function getCustomerColumns(opts: {
  t: Translate;
  fmt: (amount: number) => string;
  rowTo: (row: CustomerListItem) => string | undefined;
  extra?: ColumnDef<CustomerListItem, unknown>[];
}): ColumnDef<CustomerListItem, unknown>[] {
  const { t, fmt } = opts;
  return [
    {
      accessorKey: "name",
      header: sortHeader(t("customer")),
      meta: CUSTOMER_COLUMN_LAYOUT.name,
      cell: ({ row }) => <CustomerCell customer={row.original} to={opts.rowTo(row.original)} />,
    },
    {
      accessorKey: "totalOrders",
      header: sortHeader(t("orders")),
      meta: { ...CUSTOMER_COLUMN_LAYOUT.totalOrders, minWidth: localeWidth(CUSTOMER_COLUMN_LAYOUT.totalOrders.minWidth) },
      cell: ({ row }) => {
        const count = row.original.totalOrders;
        return <span className="whitespace-nowrap text-muted-foreground">{count === 1 ? t("orderCountOne") : t("orderCount", { count })}</span>;
      },
    },
    {
      accessorKey: "totalSpent",
      header: sortHeader(t("spent")),
      meta: CUSTOMER_COLUMN_LAYOUT.totalSpent,
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{fmt(row.original.totalSpent)}</span>,
    },
    createDateColumn("lastOrderAt", t("lastOrder")),
    ...(opts.extra ?? []),
  ];
}
