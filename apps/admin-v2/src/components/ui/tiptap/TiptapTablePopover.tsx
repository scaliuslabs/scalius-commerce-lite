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
import { useMessages } from "~/i18n";
import { richTextMessages } from "~/i18n/rich-text";

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

const TABLE_ACTIONS: ReadonlyArray<{ command: TableCommand; icon: LucideIcon }> = [
  { command: "addColumnBefore", icon: ChevronsLeftRight },
  { command: "addColumnAfter", icon: ChevronsLeftRight },
  { command: "deleteColumn", icon: Columns },
  { command: "addRowBefore", icon: Rows },
  { command: "addRowAfter", icon: Rows },
  { command: "deleteRow", icon: Rows },
  { command: "deleteTable", icon: Eraser },
  { command: "mergeCells", icon: Merge },
  { command: "splitCell", icon: Split },
  { command: "toggleHeaderColumn", icon: Columns },
  { command: "toggleHeaderRow", icon: Rows },
  { command: "toggleHeaderCell", icon: TableIcon },
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
  const t = useMessages(richTextMessages);
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
  const triggerLabel = t(isInTable ? "editTable" : "insertTable");

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
              aria-label={triggerLabel}
              aria-pressed={isInTable || undefined}
              onMouseDown={(event) => event.preventDefault()}
            >
              <TableIcon />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{triggerLabel}</TooltipContent>
      </Tooltip>

      <PopoverContent className={isFullscreen ? "z-[10001] w-[calc(100vw-2rem)] max-w-sm space-y-3 p-3" : "w-[calc(100vw-2rem)] max-w-sm space-y-3 p-3"}>
        {!isInTable ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={rowsId}>{t("rows")}</Label>
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
                <Label htmlFor={columnsId}>{t("columns")}</Label>
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
              {t("includeHeaderRow")}
            </label>
            <Button type="button" onClick={addTable} disabled={!rowsValid || !colsValid} className="w-full">
              <TableIcon /> {t("insertTable")}
            </Button>
            <p className="text-body text-muted-foreground">{t("tableLimit", { rows: 20, cols: 10 })}</p>
          </>
        ) : (
          <div className="grid gap-0.5 sm:grid-cols-2">
            {TABLE_ACTIONS.map(({ command, icon: Icon }) => (
              <button
                key={command}
                type="button"
                onClick={() => editor.chain().focus()[command]().run()}
                disabled={!tableState.can[command]}
                className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-body hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:min-h-8"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                {t(command)}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
