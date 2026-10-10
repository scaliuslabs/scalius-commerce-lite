import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";

/** A card of `lines` field-high rows under a card-title bar. */
function CardSkeleton({ lines }: { lines: number }) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <Skeleton className="h-5 w-32" />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn("h-9", index === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
      ))}
    </Card>
  );
}

function Heading({ title, back }: { title?: string; back: boolean }) {
  return (
    <div className="flex min-h-9 items-center gap-2">
      {back ? <Skeleton className="size-9 shrink-0" /> : null}
      {title ? <h1 className="text-heading-lg">{title}</h1> : <Skeleton className="h-7 w-48" />}
    </div>
  );
}

export type PageSkeletonKind = "detail" | "settings" | "index" | "page";

/**
 * The page's shape before its data (polish bar L1, L2): the real title when
 * it is known, cards where the page has cards, rows to the page size. Route
 * pending components use it; it never dims or covers content that exists.
 *
 * - `detail`: back link, title, then main ⅔ and side ⅓ cards from 1024 px.
 *   `main` and `side` list each card's number of rows.
 * - `settings`: one column of cards (`main`).
 * - `index`: title, then one card with tabs, a toolbar and `rows` rows.
 * - `page`: title, a row of three tiles and one large card.
 */
export function PageSkeleton({
  kind = "page",
  title,
  main = [3, 2],
  side = [2, 2],
  rows = 10,
}: {
  kind?: PageSkeletonKind;
  title?: string;
  main?: readonly number[];
  side?: readonly number[];
  rows?: number;
}) {
  const t = useMessages(shellMessages);
  const width = kind === "detail" ? "max-w-5xl" : kind === "settings" ? "max-w-3xl" : undefined;
  return (
    <div data-slot="skeleton" role="status" aria-busy="true" className={cn("mx-auto flex flex-col gap-4", width)}>
      <span className="sr-only">{t("loading")}</span>
      <Heading title={title} back={kind === "detail"} />
      {kind === "detail" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-4 lg:col-span-2">
            {main.map((lines, index) => <CardSkeleton key={index} lines={lines} />)}
          </div>
          <div className="flex flex-col gap-4">
            {side.map((lines, index) => <CardSkeleton key={index} lines={lines} />)}
          </div>
        </div>
      ) : kind === "settings" ? (
        main.map((lines, index) => <CardSkeleton key={index} lines={lines} />)
      ) : kind === "index" ? (
        <Card className="flex flex-col">
          <div className="flex gap-2 border-b p-2">
            {[16, 20, 24].map((size) => <Skeleton key={size} className={cn("h-8", size === 16 ? "w-16" : size === 20 ? "w-20" : "w-24")} />)}
          </div>
          <div className="flex gap-2 border-b p-2">
            <Skeleton className="h-9 flex-1" />
            <Skeleton className="h-9 w-24" />
          </div>
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="flex h-13 items-center gap-3 border-b px-3 last:border-b-0">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="ms-auto h-4 w-16" />
            </div>
          ))}
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((index) => <Skeleton key={index} className="h-24" />)}
          </div>
          <Skeleton className="h-64" />
        </>
      )}
    </div>
  );
}

/** The quiet boot spinner of index.html, for standalone pages and the first session read. */
export function BootSpinner() {
  const t = useMessages(shellMessages);
  // Same id as index.html's: the same delayed spinner and the same 12 s "Reload" offer.
  return <div id="boot" role="status" aria-label={t("loading")} />;
}
