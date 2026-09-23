import { cn } from "@scalius/shared/utils";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";

interface RichContentProps {
  content: string;
  className?: string;
  /** `product` renders body copy in the subdued text colour. */
  variant?: "default" | "compact" | "product";
}

/** Sanitised merchant HTML, styled by rich-content.css (shared with the editor). */
export function RichContent({ content, className, variant = "default" }: RichContentProps) {
  if (!content) {
    return null;
  }

  return (
    <div
      className={cn("rich-content text-body", variant === "product" && "text-muted-foreground", className)}
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(content) }}
    />
  );
}
