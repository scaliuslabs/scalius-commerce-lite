import type { Editor } from "@tiptap/react";
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
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Switch } from "../switch";
import { ToolbarButton } from "./ToolbarButton";

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
}

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
}: TiptapTablePopoverProps) {
  const addTable = () => {
    const rows = parseInt(tableRows, 10);
    const cols = parseInt(tableCols, 10);
    if (rows > 0 && cols > 0) {
      editor
        .chain()
        .focus()
        .insertTable({ rows, cols, withHeaderRow: tableWithHeader })
        .run();
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <span>
          <ToolbarButton
            onClick={() => {}}
            tooltip="Insert table"
            buttonSize={buttonSize}
          >
            <TableIcon className={iconSize} />
          </ToolbarButton>
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2 space-y-2">
        <div className="grid grid-cols-2 gap-2 items-center">
          <Input
            type="number"
            value={tableRows}
            onChange={(e) => onTableRowsChange(e.target.value)}
            placeholder="Rows"
            className="h-8 text-xs"
            min="1"
          />
          <Input
            type="number"
            value={tableCols}
            onChange={(e) => onTableColsChange(e.target.value)}
            placeholder="Cols"
            className="h-8 text-xs"
            min="1"
          />
        </div>
        <div className="flex items-center space-x-2">
          <Switch
            id="table-header"
            checked={tableWithHeader}
            onCheckedChange={onTableWithHeaderChange}
          />
          <label
            htmlFor="table-header"
            className="text-xs text-muted-foreground"
          >
            Include header row
          </label>
        </div>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={addTable}
          className="w-full text-xs"
        >
          <TableIcon className="h-3 w-3 mr-1" /> Insert Table
        </Button>

        <hr className="my-2" />
        <p className="text-xs font-medium text-muted-foreground mb-1">
          Quick Actions:
        </p>
        <div className="grid grid-cols-3 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().addColumnBefore().run()}
            disabled={!editor.can().addColumnBefore()}
            className="flex items-center gap-1 text-xs"
          >
            <ChevronsLeftRight className="h-3 w-3 transform rotate-90" />{" "}
            Col Before
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            disabled={!editor.can().addColumnAfter()}
            className="flex items-center gap-1 text-xs"
          >
            <ChevronsLeftRight className="h-3 w-3 transform rotate-90" />{" "}
            Col After
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().deleteColumn().run()}
            disabled={!editor.can().deleteColumn()}
            className="flex items-center gap-1 text-xs"
          >
            <Columns className="h-3 w-3" /> Del Col
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().addRowBefore().run()}
            disabled={!editor.can().addRowBefore()}
            className="flex items-center gap-1 text-xs"
          >
            <Rows className="h-3 w-3" /> Row Before
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().addRowAfter().run()}
            disabled={!editor.can().addRowAfter()}
            className="flex items-center gap-1 text-xs"
          >
            <Rows className="h-3 w-3" /> Row After
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().deleteRow().run()}
            disabled={!editor.can().deleteRow()}
            className="flex items-center gap-1 text-xs"
          >
            <Rows className="h-3 w-3" /> Del Row
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().deleteTable().run()}
            disabled={!editor.can().deleteTable()}
            className="flex items-center gap-1 text-xs"
          >
            <Eraser className="h-3 w-3" /> Del Table
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().mergeCells().run()}
            disabled={!editor.can().mergeCells()}
            className="flex items-center gap-1 text-xs"
          >
            <Merge className="h-3 w-3" /> Merge
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().splitCell().run()}
            disabled={!editor.can().splitCell()}
            className="flex items-center gap-1 text-xs"
          >
            <Split className="h-3 w-3" /> Split
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              editor.chain().focus().toggleHeaderColumn().run()
            }
            disabled={!editor.can().toggleHeaderColumn()}
            className="flex items-center gap-1 text-xs"
          >
            <ChevronsLeftRight className="h-3 w-3" /> H Col
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleHeaderRow().run()}
            disabled={!editor.can().toggleHeaderRow()}
            className="flex items-center gap-1 text-xs"
          >
            <Rows className="h-3 w-3" /> H Row
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editor.chain().focus().toggleHeaderCell().run()}
            disabled={!editor.can().toggleHeaderCell()}
            className="flex items-center gap-1 text-xs"
          >
            <TableIcon className="h-3 w-3" /> H Cell
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
