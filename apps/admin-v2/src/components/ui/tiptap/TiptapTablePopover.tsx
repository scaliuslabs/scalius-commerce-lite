import { useId, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { cn } from "@scalius/shared/utils";
import {
  Table as TableIcon,
  Eraser,
  Merge,
  Split,
  Rows,
  Columns,
  ChevronsLeftRight,
} from "lucide-react";
import { Button } from "../button";
import { Input } from "../input";
import { Label } from "../label";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Switch } from "../switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { insertRichTextTable } from "./tiptap-insertions";

interface TiptapTablePopoverProps {
  editor: Editor;
  buttonSize: string;
  iconSize: string;
  tableRows: string;
  tableCols: string;
  tableWithHeader: boolean;
  onTableRowsChange: (value: string) => void;
  onTableColsChange: (value: string) => void;
  onTableWithHeaderChange: (value: boolean) => void;
  isFullscreen?: boolean;
}

const MOBILE_ACTION_CLASS =
  "min-h-11 justify-start gap-1.5 px-2 text-[11px] sm:min-h-9";

export function TiptapTablePopover({
  editor,
  buttonSize,
  iconSize,
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
  const canInsert =
    Number.isInteger(rows) &&
    rows >= 1 &&
    rows <= 20 &&
    Number.isInteger(cols) &&
    cols >= 1 &&
    cols <= 10;
  const tableState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      isInTable: currentEditor.isActive("table"),
      canAddColumnBefore: currentEditor.can().addColumnBefore(),
      canAddColumnAfter: currentEditor.can().addColumnAfter(),
      canDeleteColumn: currentEditor.can().deleteColumn(),
      canAddRowBefore: currentEditor.can().addRowBefore(),
      canAddRowAfter: currentEditor.can().addRowAfter(),
      canDeleteRow: currentEditor.can().deleteRow(),
      canDeleteTable: currentEditor.can().deleteTable(),
      canMergeCells: currentEditor.can().mergeCells(),
      canSplitCell: currentEditor.can().splitCell(),
      canToggleHeaderColumn: currentEditor.can().toggleHeaderColumn(),
      canToggleHeaderRow: currentEditor.can().toggleHeaderRow(),
      canToggleHeaderCell: currentEditor.can().toggleHeaderCell(),
    }),
  });
  const isInTable = tableState.isInTable;

  const addTable = () => {
    if (!canInsert) return;
    const inserted = insertRichTextTable(editor, {
      rows,
      cols,
      withHeaderRow: tableWithHeader,
    });
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
              size="icon"
              aria-label={isInTable ? "Edit table" : "Insert table"}
              className={cn(buttonSize, isInTable && "bg-accent")}
              onMouseDown={(event) => event.preventDefault()}
            >
              <TableIcon className={iconSize} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={5}>
          <p className="text-xs">{isInTable ? "Edit table" : "Insert table"}</p>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        className={cn(
          "w-[calc(100vw-2rem)] max-w-sm space-y-3 p-3",
          isFullscreen && "z-[10001]",
        )}
      >
        {!isInTable ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={rowsId} className="text-xs">
                  Rows
                </Label>
                <Input
                  id={rowsId}
                  type="number"
                  value={tableRows}
                  onChange={(event) => onTableRowsChange(event.target.value)}
                  aria-label="Table rows"
                  className="h-11 text-sm sm:h-9"
                  min="1"
                  max="20"
                  inputMode="numeric"
                  aria-invalid={Boolean(tableRows) && !(Number.isInteger(rows) && rows >= 1 && rows <= 20)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={columnsId} className="text-xs">
                  Columns
                </Label>
                <Input
                  id={columnsId}
                  type="number"
                  value={tableCols}
                  onChange={(event) => onTableColsChange(event.target.value)}
                  aria-label="Table columns"
                  className="h-11 text-sm sm:h-9"
                  min="1"
                  max="10"
                  inputMode="numeric"
                  aria-invalid={Boolean(tableCols) && !(Number.isInteger(cols) && cols >= 1 && cols <= 10)}
                />
              </div>
            </div>
            <label
              htmlFor={headerId}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 text-sm"
            >
              <Switch
                id={headerId}
                checked={tableWithHeader}
                onCheckedChange={onTableWithHeaderChange}
              />
              Include a header row
            </label>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={addTable}
              disabled={!canInsert}
              className="min-h-11 w-full text-sm sm:min-h-9"
            >
              <TableIcon className="mr-1 h-3.5 w-3.5" /> Insert table
            </Button>
            <p className="text-xs text-muted-foreground">
              Up to 20 rows and 10 columns.
            </p>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-muted-foreground">
              Table actions
            </p>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addColumnBefore().run()}
                disabled={!tableState.canAddColumnBefore}
                className={MOBILE_ACTION_CLASS}
              >
                <ChevronsLeftRight className="h-3.5 w-3.5 rotate-90" /> Add column before
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addColumnAfter().run()}
                disabled={!tableState.canAddColumnAfter}
                className={MOBILE_ACTION_CLASS}
              >
                <ChevronsLeftRight className="h-3.5 w-3.5 rotate-90" /> Add column after
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().deleteColumn().run()}
                disabled={!tableState.canDeleteColumn}
                className={MOBILE_ACTION_CLASS}
              >
                <Columns className="h-3.5 w-3.5" /> Delete column
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addRowBefore().run()}
                disabled={!tableState.canAddRowBefore}
                className={MOBILE_ACTION_CLASS}
              >
                <Rows className="h-3.5 w-3.5" /> Add row before
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().addRowAfter().run()}
                disabled={!tableState.canAddRowAfter}
                className={MOBILE_ACTION_CLASS}
              >
                <Rows className="h-3.5 w-3.5" /> Add row after
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().deleteRow().run()}
                disabled={!tableState.canDeleteRow}
                className={MOBILE_ACTION_CLASS}
              >
                <Rows className="h-3.5 w-3.5" /> Delete row
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().deleteTable().run()}
                disabled={!tableState.canDeleteTable}
                className={MOBILE_ACTION_CLASS}
              >
                <Eraser className="h-3.5 w-3.5" /> Delete table
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().mergeCells().run()}
                disabled={!tableState.canMergeCells}
                className={MOBILE_ACTION_CLASS}
              >
                <Merge className="h-3.5 w-3.5" /> Merge cells
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().splitCell().run()}
                disabled={!tableState.canSplitCell}
                className={MOBILE_ACTION_CLASS}
              >
                <Split className="h-3.5 w-3.5" /> Split cell
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().toggleHeaderColumn().run()}
                disabled={!tableState.canToggleHeaderColumn}
                className={MOBILE_ACTION_CLASS}
              >
                <Columns className="h-3.5 w-3.5" /> Header column
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().toggleHeaderRow().run()}
                disabled={!tableState.canToggleHeaderRow}
                className={MOBILE_ACTION_CLASS}
              >
                <Rows className="h-3.5 w-3.5" /> Header row
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editor.chain().focus().toggleHeaderCell().run()}
                disabled={!tableState.canToggleHeaderCell}
                className={MOBILE_ACTION_CLASS}
              >
                <TableIcon className="h-3.5 w-3.5" /> Header cell
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
