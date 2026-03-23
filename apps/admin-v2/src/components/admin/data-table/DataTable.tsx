import { useMemo, useCallback, type ReactNode } from "react";
import { flexRender, type Table, type Row } from "@tanstack/react-table";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@scalius/shared/utils";
import { useIsMobile } from "~/hooks/use-mobile";
import { DataTablePagination } from "./DataTablePagination";
import { DataTableLoadingOverlay } from "./DataTableLoadingOverlay";
import { DataTableEmptyState, type EmptyStateConfig } from "./DataTableEmptyState";

interface DataTableProps<TData> {
  table: Table<TData>;
  isFetching: boolean;
  isLoading: boolean;
  toolbar?: ReactNode;
  emptyState?: EmptyStateConfig;
  mobileCardRenderer?: (row: Row<TData>) => ReactNode;
  itemLabel?: string;
  pageSizeOptions?: number[];
  className?: string;
  /** Enable drag-and-drop row reordering. Rows must have an `id` field. */
  sortable?: boolean;
  /** Called after a drag-and-drop reorder with old and new index. */
  onReorder?: (oldIndex: number, newIndex: number) => void;
}

/** A single sortable table row used when `sortable` is enabled */
function SortableTableRow<TData>({
  row,
  children,
}: {
  row: Row<TData>;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <TableRow
      ref={setNodeRef}
      style={style}
      data-state={row.getIsSelected() ? "selected" : undefined}
      className={cn(
        isDragging && "bg-primary/5 opacity-50 shadow-lg ring-1 ring-primary/20",
      )}
    >
      {/* Inject drag handle as first cell */}
      <TableCell className="w-[40px] px-2">
        <div
          {...attributes}
          {...listeners}
          className="flex h-7 w-7 cursor-grab items-center justify-center rounded hover:bg-muted"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-muted-foreground"
          >
            <circle cx="9" cy="12" r="1" />
            <circle cx="9" cy="5" r="1" />
            <circle cx="9" cy="19" r="1" />
            <circle cx="15" cy="12" r="1" />
            <circle cx="15" cy="5" r="1" />
            <circle cx="15" cy="19" r="1" />
          </svg>
        </div>
      </TableCell>
      {children}
    </TableRow>
  );
}

export function DataTable<TData>({
  table,
  isFetching,
  isLoading,
  toolbar,
  emptyState,
  mobileCardRenderer,
  itemLabel = "items",
  pageSizeOptions,
  className,
  sortable = false,
  onReorder,
}: DataTableProps<TData>) {
  const isMobile = useIsMobile();
  const rows = table.getRowModel().rows;
  const hasRows = rows.length > 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const sortableIds = useMemo(
    () => (sortable ? rows.map((r) => r.id) : []),
    [sortable, rows],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !onReorder) return;

      const oldIndex = rows.findIndex((r) => r.id === active.id);
      const newIndex = rows.findIndex((r) => r.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        onReorder(oldIndex, newIndex);
      }
    },
    [rows, onReorder],
  );

  const renderDesktopTable = () => (
    <UITable>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {sortable && <TableHead className="w-[40px]" />}
            {headerGroup.headers.map((header) => (
              <TableHead
                key={header.id}
                style={{
                  width: header.getSize() !== 150 ? header.getSize() : undefined,
                }}
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {hasRows ? (
          rows.map((row) =>
            sortable ? (
              <SortableTableRow key={row.id} row={row}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(
                      cell.column.columnDef.cell,
                      cell.getContext(),
                    )}
                  </TableCell>
                ))}
              </SortableTableRow>
            ) : (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(
                      cell.column.columnDef.cell,
                      cell.getContext(),
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ),
          )
        ) : (
          <TableRow>
            <TableCell
              colSpan={table.getAllColumns().length + (sortable ? 1 : 0)}
              className="h-24 text-center"
            >
              <DataTableEmptyState config={emptyState} />
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </UITable>
  );

  return (
    <div className={className}>
      {toolbar}

      <div className="relative rounded-md border">
        <DataTableLoadingOverlay visible={isFetching && !isLoading} />

        {isMobile && mobileCardRenderer ? (
          // Mobile card view
          <div className="divide-y">
            {hasRows ? (
              rows.map((row) => (
                <div key={row.id}>{mobileCardRenderer(row)}</div>
              ))
            ) : (
              <DataTableEmptyState config={emptyState} />
            )}
          </div>
        ) : sortable ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sortableIds}
              strategy={verticalListSortingStrategy}
            >
              {renderDesktopTable()}
            </SortableContext>
          </DndContext>
        ) : (
          renderDesktopTable()
        )}
      </div>

      <DataTablePagination
        table={table}
        itemLabel={itemLabel}
        pageSizeOptions={pageSizeOptions}
      />
    </div>
  );
}
