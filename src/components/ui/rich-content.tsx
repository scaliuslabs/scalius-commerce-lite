import { cn } from "@/lib/utils";
import "./rich-content.css";

interface RichContentProps {
  content: string;
  className?: string;
  /**
   * Customize the appearance of the rich content
   */
  variant?: "default" | "compact" | "product";
}

export function RichContent({
  content,
  className,
  variant = "default",
}: RichContentProps) {
  if (!content) {
    return null;
  }

  return (
    <div
      className={cn(
        "prose max-w-none rich-content",
        // Base styling
        "prose-headings:font-semibold prose-headings:mb-3 prose-headings:mt-6",
        "prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg",
        "prose-h4:text-base prose-h5:text-sm prose-h6:text-sm",
        "prose-p:leading-relaxed prose-p:mb-4",
        "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
        "prose-strong:font-semibold",
        "prose-em:italic",
        "prose-u:underline",
        "prose-s:line-through",
        // List styling
        "prose-ul:pl-5 prose-ol:pl-5",
        "prose-ul:list-disc prose-ol:list-decimal",
        "prose-li:mb-1 prose-li:pl-1",
        // Image styling
        "prose-img:rounded-md",
        "prose-hr:my-6",
        // Table styling
        "prose-table:border-collapse prose-table:w-full",
        "prose-th:border prose-th:border-gray-300 prose-th:p-2 prose-th:bg-gray-100",
        "prose-td:border prose-td:border-gray-300 prose-td:p-2",
        // Code styling
        "prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-gray-800 prose-code:text-sm",
        "prose-pre:bg-gray-100 prose-pre:p-4 prose-pre:rounded-md prose-pre:overflow-x-auto",
        "prose-pre:code:bg-transparent prose-pre:code:p-0",
        // Blockquote styling
        "prose-blockquote:border-l-4 prose-blockquote:border-gray-300 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:my-4 prose-blockquote:text-gray-700",
        // Variant-specific styling
        variant === "default" && "prose-sm md:prose-base",
        variant === "compact" && "prose-xs md:prose-sm",
        variant === "product" && [
          "prose-sm md:prose-base",
          "prose-headings:text-gray-900",
          "prose-p:text-gray-700",
          "prose-a:text-primary",
          "prose-img:my-4",
          "prose-ul:text-gray-700 prose-ol:text-gray-700",
          "prose-li:text-gray-700",
          "prose-code:text-gray-800",
          "prose-blockquote:text-gray-700",
        ],
        className,
      )}
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}
