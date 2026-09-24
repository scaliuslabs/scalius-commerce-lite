import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { dataTableMessages } from "~/i18n/data-table";

/**
 * Cell rules for every list (Polaris IndexTable): identifiers stay on one line
 * and truncate with the full value on hover and in the copy button's name;
 * names take at most two lines with their variant or option text muted.
 */

/** SKU, barcode, order number, code: one line, never split, optional copy button. */
export function IdText({
  value,
  copy = false,
  className,
}: {
  value: string | null | undefined;
  /** Adds a copy button (shown on row hover and on focus). */
  copy?: boolean;
  className?: string;
}) {
  const t = useMessages(dataTableMessages);
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("group/id inline-flex max-w-full min-w-0 items-center gap-1 align-middle", className)}>
      <span title={value} className="min-w-0 max-w-60 truncate whitespace-nowrap font-mono">
        {value}
      </span>
      {copy ? (
        <button
          type="button"
          aria-label={copied ? t("copied") : t("copy", { value })}
          data-row-click-ignore=""
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/id:opacity-100 pointer-coarse:opacity-100"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        </button>
      ) : null}
    </span>
  );
}

/** A record's name on at most two lines, its variant or option text muted on one. */
export function NameText({ name, detail, className }: { name: ReactNode; detail?: ReactNode; className?: string }) {
  return (
    <span className={cn("block min-w-0", className)}>
      <span className="line-clamp-2 break-words font-medium">{name}</span>
      {detail ? <span className="block truncate text-muted-foreground">{detail}</span> : null}
    </span>
  );
}
