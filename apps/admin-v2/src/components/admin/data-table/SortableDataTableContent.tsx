import { useCallback, useMemo, type ReactNode } from "react";
import {
  flexRender,
  type Column,
  type Row,
  type Table,
  type TableRowData,
} from "./table-config";
import { columnAttributes } from "./column-attributes";
import { SELECT_COLUMN } from "./column-layout";
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
import { GripVertical } from "lucide-react";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataTableEmptyState, type EmptyStateConfig } from "./DataTableEmptyState";
import { DataTableHeadCell } from "./DataTableBodyRow";
import { getSortableStyle } from "../shared/sortable-style";

export interface SortableDataTableContentProps<TData extends TableRowData> {
  table: Table<TData>;
  /** Columns to show, in order (the table's column layout). */
  columns: Column<TData, unknown>[];
  rows: Row<TData>[];
  hasRows: boolean;
  showInitialLoading: boolean;
  emptyState?: EmptyStateConfig;
  onReorder?: (oldIndex: number, newIndex: number) => void;
}

function SortableTableRow<TData extends TableRowData>({
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

  const style = getSortableStyle(transform, transition, isDragging ? { opacity: 0.5 } : undefined);

  return (
    <TableRow
      ref={setNodeRef}
      // eslint-disable-next-line shadcn/no-inline-styles -- dnd-kit moves the dragged row with a live transform.
      style={style}
      data-state={row.getIsSelected() || isDragging ? "selected" : undefined}
    >
      <TableCell className="w-[40px] px-2">
        <div
          {...attributes}
          {...listeners}
          className="flex h-7 w-7 cursor-grab items-center justify-center rounded hover:bg-muted"
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>
      </TableCell>
      {children}
    </TableRow>
  );
}

export function SortableDataTableContent<TData extends TableRowData>({
  table,
  columns,
  rows,
  hasRows,
  showInitialLoading,
  emptyState,
  onReorder,
}: SortableDataTableContentProps<TData>) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const sortableIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const headers = new Map(table.getFlatHeaders().map((header) => [header.column.id, header]));
  const hasSelect = columns.some((column) => column.id === SELECT_COLUMN);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !onReorder) return;

      const oldIndex = rows.findIndex((row) => row.id === active.id);
      const newIndex = rows.findIndex((row) => row.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        onReorder(oldIndex, newIndex);
      }
    },
    [rows, onReorder],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={sortableIds}
        strategy={verticalListSortingStrategy}
      >
        <UITable>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                <TableHead className="w-[40px]" />
                {columns.map((column) => (
                  <DataTableHeadCell key={column.id} column={column} header={headers.get(column.id)} hasSelect={hasSelect} />
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {hasRows ? (
              rows.map((row) => (
                <SortableTableRow key={row.id} row={row}>
                  {columns.map((column) => {
                    const cell = row.getAllCells().find((candidate) => candidate.column.id === column.id);
                    return cell ? (
                      <TableCell key={cell.id} {...columnAttributes(column, hasSelect)}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ) : null;
                  })}
                </SortableTableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length + 1}
                  className="h-24 text-center"
                >
                  {showInitialLoading ? (
                    <div className="flex items-center justify-center py-10">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
                    </div>
                  ) : (
                    <DataTableEmptyState config={emptyState} />
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </UITable>
      </SortableContext>
    </DndContext>
  );
}
