import type { ReactNode } from "react";
import { unixToDate } from "@scalius/shared/timestamps";
import { formatDateTime } from "~/i18n";
import { DataTableColumnHeader } from "~/components/admin/data-table/DataTableColumnHeader";
import type { Column, TableRowData } from "~/components/admin/data-table/table-config";

/** Sortable column header: `header: sortHeader(t("updated"))`. */
export function sortHeader(title: string) {
  return function SortHeader<T extends TableRowData>({ column }: { column: Column<T, unknown> }) {
    return <DataTableColumnHeader column={column} title={title} />;
  };
}

/** Locale-aware short date for list cells. */
export function DateText({ value }: { value: Date | string | number | null | undefined }): ReactNode {
  const date = unixToDate(value);
  return date ? <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(date, { dateStyle: "medium" })}</span> : null;
}

/** Square thumbnail (or icon) in front of a row title. */
export function Thumb({ src, icon: Icon }: { src?: string | null; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
      {src ? <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" /> : <Icon className="h-4 w-4 text-muted-foreground" />}
    </span>
  );
}
