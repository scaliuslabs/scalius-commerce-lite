import type { FlueConversationPart } from "@flue/sdk";
import {
  AssistantShortAnswer,
  AssistantToolProgress,
} from "@scalius/ui/assistant";
import { AlertCircle } from "lucide-react";

const MAX_VISIBLE_TOOL_ROWS = 3;
const MAX_VISIBLE_TEXT_CHARACTERS = 4_000;

function cleanText(value: string): string {
  return Array.from(value.replace(/\r\n?/g, "\n"), (character) => {
    if (character === "\n" || character === "\t") return character;
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/[\u2028\u2029]/g, " ")
    .trim()
    .slice(0, MAX_VISIBLE_TEXT_CHARACTERS);
}

function toolLabel(
  part: Extract<
    FlueConversationPart,
    {
      type: "dynamic-tool";
    }
  >,
): string {
  if (part.toolName === "computer") {
    if (part.state === "input-available") return "Using this page";
    if (part.state === "output-error") return "Page action needs attention";
    return "Page action finished";
  }
  if (part.toolName === "scalius") {
    if (part.state === "input-available") return "Checking the catalog";
    if (part.state === "output-error") return "Catalog check needs attention";
    return "Catalog checked";
  }
  return part.state === "input-available"
    ? "Working"
    : part.state === "output-error"
      ? "Step needs attention"
      : "Step finished";
}

export function StorefrontFlueMessageParts({
  parts,
}: {
  parts: readonly FlueConversationPart[];
}) {
  const text = cleanText(
    parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n"),
  );
  const toolParts = parts
    .filter(
      (
        part,
      ): part is Extract<
        FlueConversationPart,
        {
          type: "dynamic-tool";
        }
      > => part.type === "dynamic-tool",
    )
    .slice(-MAX_VISIBLE_TOOL_ROWS);
  const hiddenToolCount = Math.max(
    0,
    parts.filter((part) => part.type === "dynamic-tool").length -
      toolParts.length,
  );
  return (
    <div className="grid gap-2.5">
      {text ? (
        <AssistantShortAnswer
          summary={text}
          details={
            text.length > 420 ? (
              <p className="max-h-72 overflow-auto whitespace-pre-wrap break-words pr-1">
                {text}
              </p>
            ) : undefined
          }
        />
      ) : null}

      {toolParts.length > 0 ? (
        <AssistantToolProgress
          label="Assistant work"
          steps={toolParts.map((part) => ({
            id: part.toolCallId,
            label: toolLabel(part),
            status:
              part.state === "input-available"
                ? ("running" as const)
                : part.state === "output-error"
                  ? ("failed" as const)
                  : ("complete" as const),
          }))}
        />
      ) : null}
      {hiddenToolCount > 0 ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <AlertCircle className="size-3.5" aria-hidden="true" />
          {hiddenToolCount} earlier {hiddenToolCount === 1 ? "step" : "steps"}{" "}
          condensed.
        </p>
      ) : null}

      {!text && toolParts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This assistant message had no displayable content.
        </p>
      ) : null}
    </div>
  );
}
