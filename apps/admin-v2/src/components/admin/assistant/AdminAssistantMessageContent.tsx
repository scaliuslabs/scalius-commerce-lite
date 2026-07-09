import { Fragment, useMemo, type ReactNode } from "react";

interface AdminAssistantMessageContentProps {
  content: string;
}

type AssistantMessageBlock =
  | { type: "paragraph"; text: string }
  | { type: "ordered-list"; items: string[] }
  | { type: "unordered-list"; items: string[] };

export function AdminAssistantMessageContent({
  content,
}: AdminAssistantMessageContentProps) {
  const blocks = useMemo(() => parseAssistantMessageBlocks(content), [content]);

  return (
    <div className="space-y-2.5">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === "ordered-list") {
          return (
            <ol key={key} className="list-decimal space-y-1.5 pl-5 marker:text-muted-foreground">
              {block.items.map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`}>
                  {renderInlineAssistantMarkdown(item)}
                </li>
              ))}
            </ol>
          );
        }
        if (block.type === "unordered-list") {
          return (
            <ul key={key} className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
              {block.items.map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`}>
                  {renderInlineAssistantMarkdown(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={key} className="whitespace-pre-wrap">
            {renderInlineAssistantMarkdown(block.text)}
          </p>
        );
      })}
    </div>
  );
}

function parseAssistantMessageBlocks(content: string): AssistantMessageBlock[] {
  const blocks: AssistantMessageBlock[] = [];
  const paragraphs = content
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const orderedItems = lines.map(
      (line) => line.match(/^\d+[.)]\s+(.+)$/)?.[1] ?? null,
    );
    if (orderedItems.length > 0 && orderedItems.every(Boolean)) {
      blocks.push({ type: "ordered-list", items: orderedItems as string[] });
      continue;
    }

    const unorderedItems = lines.map(
      (line) => line.match(/^[-*]\s+(.+)$/)?.[1] ?? null,
    );
    if (unorderedItems.length > 0 && unorderedItems.every(Boolean)) {
      blocks.push({ type: "unordered-list", items: unorderedItems as string[] });
      continue;
    }

    blocks.push({ type: "paragraph", text: paragraph });
  }

  return blocks.length > 0 ? blocks : [{ type: "paragraph", text: content }];
}

function renderInlineAssistantMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const marker = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(
        <Fragment key={`text-${index}`}>{text.slice(lastIndex, start)}</Fragment>,
      );
      index += 1;
    }

    if (marker.startsWith("`")) {
      nodes.push(
        <code
          key={`code-${index}`}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] text-foreground"
        >
          {marker.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <strong key={`strong-${index}`} className="font-semibold text-foreground">
          {marker.slice(2, -2)}
        </strong>,
      );
    }
    index += 1;
    lastIndex = start + marker.length;
  }

  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`text-${index}`}>{text.slice(lastIndex)}</Fragment>);
  }

  return nodes.length > 0 ? nodes : [text];
}
