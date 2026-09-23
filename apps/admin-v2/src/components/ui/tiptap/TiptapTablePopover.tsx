import { useId, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { Table as TableIcon, Eraser, Merge, Split, Rows, Columns, ChevronsLeftRight, type LucideIcon } from "lucide-react";
import { Button } from "../button";
import { Input } from "../input";
import { Label } from "../label";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Switch } from "../switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { insertRichTextTable } from "./tiptap-insertions";

interface TiptapTablePopoverProps {
  editor: Editor;
  compact?: boolean;
  tableRows: string;
  tableCols: string;
  tableWithHeader: boolean;
  onTableRowsChange: (value: string) => void;
  onTableColsChange: (value: string) => void;
  onTableWithHeaderChange: (value: boolean) => void;
  isFullscreen?: boolean;
}

type TableCommand =
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "deleteTable"
  | "mergeCells"
  | "splitCell"
  | "toggleHeaderColumn"
  | "toggleHeaderRow"
  | "toggleHeaderCell";

const TABLE_ACTIONS: ReadonlyArray<{ command: TableCommand; label: string; icon: LucideIcon }> = [
  { command: "addColumnBefore", label: "Add column before", icon: ChevronsLeftRight },
  { command: "addColumnAfter", label: "Add column after", icon: ChevronsLeftRight },
  { command: "deleteColumn", label: "Delete column", icon: Columns },
  { command: "addRowBefore", label: "Add row before", icon: Rows },
  { command: "addRowAfter", label: "Add row after", icon: Rows },
  { command: "deleteRow", label: "Delete row", icon: Rows },
  { command: "deleteTable", label: "Delete table", icon: Eraser },
  { command: "mergeCells", label: "Merge cells", icon: Merge },
  { command: "splitCell", label: "Split cell", icon: Split },
  { command: "toggleHeaderColumn", label: "Header column", icon: Columns },
  { command: "toggleHeaderRow", label: "Header row", icon: Rows },
  { command: "toggleHeaderCell", label: "Header cell", icon: TableIcon },
];

export function TiptapTablePopover({
  editor,
  compact = false,
  tableRows,
  tableCols,
  tableWithHeader,
  onTableRowsChange,
  onTableColsChange,
  onTableWithHeaderChange,
  isFullscreen = false,
}: TiptapTablePopoverProps) {
  const fieldId = useId();
  const rowsId = `${fieldId}-table-rows`;
  const columnsId = `${fieldId}-table-columns`;
  const headerId = `${fieldId}-table-header`;
  const [open, setOpen] = useState(false);
  const rows = Number(tableRows);
  const cols = Number(tableCols);
  const rowsValid = Number.isInteger(rows) && rows >= 1 && rows <= 20;
  const colsValid = Number.isInteger(cols) && cols >= 1 && cols <= 10;
  const tableState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      isInTable: currentEditor.isActive("table"),
      can: Object.fromEntries(
        TABLE_ACTIONS.map(({ command }) => [command, currentEditor.can()[command]()]),
      ) as Record<TableCommand, boolean>,
    }),
  });
  const isInTable = tableState.isInTable;

  const addTable = () => {
    if (!rowsValid || !colsValid) return;
    const inserted = insertRichTextTable(editor, { rows, cols, withHeaderRow: tableWithHeader });
    if (!inserted) return;
    setOpen(false);
    requestAnimationFrame(() => {
      editor.commands.focus(undefined, { scrollIntoView: false });
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={compact ? "icon-sm" : "icon"}
              aria-label={isInTable ? "Edit table" : "Insert table"}
              aria-pressed={isInTable || undefined}
              onMouseDown={(event) => event.preventDefault()}
            >
              <TableIcon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{isInTable ? "Edit table" : "Insert table"}</TooltipContent>
      </Tooltip>

      <PopoverContent className={isFullscreen ? "z-[10001] w-[calc(100vw-2rem)] max-w-sm space-y-3 p-3" : "w-[calc(100vw-2rem)] max-w-sm space-y-3 p-3"}>
        {!isInTable ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={rowsId}>Rows</Label>
                <Input
                  id={rowsId}
                  type="number"
                  value={tableRows}
                  onChange={(event) => onTableRowsChange(event.target.value)}
                  min="1"
                  max="20"
                  inputMode="numeric"
                  aria-invalid={Boolean(tableRows) && !rowsValid}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={columnsId}>Columns</Label>
                <Input
                  id={columnsId}
                  type="number"
                  value={tableCols}
                  onChange={(event) => onTableColsChange(event.target.value)}
                  min="1"
                  max="10"
                  inputMode="numeric"
                  aria-invalid={Boolean(tableCols) && !colsValid}
                />
              </div>
            </div>
            <label htmlFor={headerId} className="flex min-h-11 cursor-pointer items-center gap-2 text-body sm:min-h-8">
              <Switch id={headerId} checked={tableWithHeader} onCheckedChange={onTableWithHeaderChange} />
              Include a header row
            </label>
            <Button type="button" onClick={addTable} disabled={!rowsValid || !colsValid} className="w-full">
              <TableIcon /> Insert table
            </Button>
            <p className="text-body text-muted-foreground">Up to 20 rows and 10 columns.</p>
          </>
        ) : (
          <div className="grid gap-0.5 sm:grid-cols-2">
            {TABLE_ACTIONS.map(({ command, label, icon: Icon }) => (
              <button
                key={command}
                type="button"
                onClick={() => editor.chain().focus()[command]().run()}
                disabled={!tableState.can[command]}
                className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-body hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:min-h-8"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                {label}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
