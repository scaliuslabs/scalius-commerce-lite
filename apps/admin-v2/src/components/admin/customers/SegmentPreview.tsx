import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { CustomerCell } from "~/components/admin/CustomerCell";
import { useDebounce } from "~/hooks/use-debounce";
import {
  customerSegmentPreviewQueryOptions,
  type CustomerSegmentDefinitionBody,
} from "~/lib/api-query-options/customers";
import { useMessages } from "~/i18n";
import { customerSegmentMessages } from "~/i18n/customer-segments";
import { segmentMembersLabel } from "./segment-actions";

/** Waits this long after the last change before counting again. */
export const SEGMENT_PREVIEW_DEBOUNCE_MS = 400;

/**
 * Who the filters match right now: the live count ("100,000+" past the cap)
 * and the first ten customers, each linking to their page. Counts again
 * 400 ms after the filters stop changing; nothing is saved.
 */
export function SegmentPreview({ definition }: { definition: CustomerSegmentDefinitionBody | null }) {
  const t = useMessages(customerSegmentMessages);
  // A string, so an unchanged definition never restarts the wait.
  const settled = useDebounce(definition ? JSON.stringify(definition) : null, SEGMENT_PREVIEW_DEBOUNCE_MS);
  const current = definition ? JSON.stringify(definition) : null;
  const preview = useQuery({
    ...customerSegmentPreviewQueryOptions(settled ? (JSON.parse(settled) as CustomerSegmentDefinitionBody) : ({} as CustomerSegmentDefinitionBody)),
    enabled: settled !== null && settled === current,
    placeholderData: keepPreviousData,
  });
  const data = current ? preview.data : undefined;
  const waiting = current !== null && (settled !== current || preview.isFetching);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("preview")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {current === null ? (
          <p className="text-body text-muted-foreground">{t("previewIncomplete")}</p>
        ) : preview.isError && !waiting ? (
          <div className="space-y-2">
            <p className="text-body text-destructive">{t("previewFailed")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void preview.refetch()}>{t("retry")}</Button>
          </div>
        ) : !data ? (
          <Skeleton className="h-6 w-32" />
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-2" aria-live="polite">
              <span className="text-heading-md tabular-nums">{segmentMembersLabel(t, data)}</span>
              {waiting ? <span className="text-body text-muted-foreground">{t("counting")}</span> : null}
            </p>
            {data.customers.length === 0 ? (
              <p className="text-body text-muted-foreground">{t("previewNone")}</p>
            ) : (
              <div className="space-y-1">
                <p className="text-body text-muted-foreground">{t("previewFirst", { count: data.customers.length })}</p>
                <ul className="divide-y border-t">
                  {data.customers.map((customer) => (
                    <li key={customer.id} className="py-2 text-body">
                      <CustomerCell customer={customer} to={`/admin/customers/${customer.id}/edit`} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
