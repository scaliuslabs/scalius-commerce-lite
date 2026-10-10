import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { useShownAfter } from "./use-shown-after";

/**
 * A refetch (search, filter, sort, the next page) keeps the rows on screen
 * and readable (L4): a 2px line crawls along the top of the rows, only for a
 * wait longer than 300ms (L3). It shares the page-loading bar's motion
 * (`data-admin-navigation-progress` in global.css).
 */
export function DataTableRefetchBar({ busy }: { busy: boolean }) {
  const t = useMessages(resourceMessages);
  const shown = useShownAfter(busy);
  return (
    <>
      {shown ? (
        <div
          data-admin-navigation-progress=""
          data-state={busy ? "loading" : "done"}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5"
        >
          <div className="h-full w-full bg-primary" />
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {shown && busy ? t("loading") : ""}
      </span>
    </>
  );
}
