import { Copy, Plus, Power, PowerOff, Shuffle, X } from "lucide-react";
import { useState } from "react";

import {
  addPromotionCodes,
  type PromotionEditorCode,
} from "./promotion-editor-model";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    bytes.forEach((_, index) => { bytes[index] = (Date.now() + index * 17) % 256; });
  }
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function PromotionCodesEditor({
  codes,
  entry,
  onCodesChange,
  onEntryChange,
}: {
  codes: PromotionEditorCode[];
  entry: string;
  onCodesChange: (codes: PromotionEditorCode[]) => void;
  onEntryChange: (entry: string) => void;
}) {
  const [entryError, setEntryError] = useState<string | null>(null);

  function commitEntry(value = entry) {
    if (!value.trim()) return;
    const result = addPromotionCodes(codes, value);
    onCodesChange(result.codes);
    if (result.rejected.length > 0) {
      setEntryError(`Could not add: ${result.rejected.join(", ")}`);
      return;
    }
    setEntryError(null);
    onEntryChange("");
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Add promotion codes</span>
          <Input
            value={entry}
            onChange={(event) => onEntryChange(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commitEntry();
              }
            }}
            onBlur={() => {
              if (entry.trim()) commitEntry();
            }}
            className="h-9 font-mono uppercase"
            placeholder="WELCOME10"
            maxLength={5000}
            aria-invalid={entryError ? true : undefined}
          />
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9"
              onClick={() => commitEntry(generateCode())}
              aria-label="Generate a code"
            >
              <Shuffle className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Generate code</TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 px-3"
          disabled={!entry.trim()}
          onClick={() => commitEntry()}
        >
          <Plus className="mr-1.5 size-4" />Add
        </Button>
      </div>
      {entryError ? <p className="text-xs text-destructive">{entryError}</p> : null}
      <p className="text-xs text-muted-foreground">
        Press Enter or paste comma-separated codes. Codes are matched without letter case.
      </p>

      {codes.length > 0 ? (
        <div className="max-h-48 overflow-y-auto rounded-lg border">
          {codes.map((code, index) => (
            <div
              key={`${code.code}:${index}`}
              className={`flex items-center gap-2 px-3 py-2 ${index > 0 ? "border-t" : ""}`}
            >
              <button
                type="button"
                className={`flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors ${code.isActive ? "bg-foreground text-background" : "text-muted-foreground"}`}
                onClick={() => onCodesChange(codes.map((item, itemIndex) => (
                  itemIndex === index ? { ...item, isActive: !item.isActive } : item
                )))}
                aria-label={`${code.isActive ? "Disable" : "Enable"} ${code.code}`}
              >
                {code.isActive ? <Power className="size-3.5" /> : <PowerOff className="size-3.5" />}
              </button>
              <code className={`min-w-0 flex-1 truncate font-mono text-sm font-semibold ${code.isActive ? "" : "text-muted-foreground line-through"}`}>
                {code.code}
              </code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => void navigator.clipboard?.writeText(code.code)}
                    aria-label={`Copy ${code.code}`}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy code</TooltipContent>
              </Tooltip>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() => onCodesChange(codes.filter((_, itemIndex) => itemIndex !== index))}
                aria-label={`Remove ${code.code}`}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <p className="text-right text-[11px] text-muted-foreground">{codes.length}/90 codes</p>
    </div>
  );
}
