import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

/**
 * Phone selection mode for lists: while rows are selected, a bar pinned to the
 * bottom shows the count, the bulk actions and Clear. Desktop keeps the
 * toolbar's bulk actions, so this only renders below `md`.
 */
export function SelectionSheet({
  count,
  clearLabel,
  onClear,
  children,
}: {
  count: number;
  clearLabel: string;
  onClear: () => void;
  children: ReactNode;
}) {
  const t = useMessages(resourceMessages);
  if (count === 0) return null;
  return (
    <>
      <div aria-hidden="true" className="h-20 md:hidden" />
      <div
        role="region"
        aria-label={t("selected", { count })}
        className="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center gap-2 border-t bg-background p-3 md:hidden"
      >
        <span className="mr-auto text-body font-medium">{t("selected", { count })}</span>
        <Button type="button" variant="ghost" onClick={onClear}>
          {clearLabel}
        </Button>
        {children}
      </div>
    </>
  );
}
