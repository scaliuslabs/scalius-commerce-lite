import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Clock3 } from "lucide-react";
import { toast } from "sonner";

import { EditorSheet, EmptyState, StatusBadge } from "~/components/admin/shell";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getNavigationPublications,
  rollbackNavigationMenuAuthority,
  type NavigationMenuSummary,
} from "~/lib/api-functions/navigation-authority";
import { queryKeys } from "~/lib/query-keys";

import { formatDateTime } from "./navigation-authority-model";

export interface NavigationHistorySheetProps {
  menu: NavigationMenuSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: () => void;
}

/**
 * Publication history. Restoring an earlier version republishes it as a new
 * revision instead of rewinding the counter, so the audit trail stays linear.
 */
export function NavigationHistorySheet({
  menu,
  open,
  onOpenChange,
  onRestored,
}: NavigationHistorySheetProps) {
  const [restoreRevision, setRestoreRevision] = useState<number | null>(null);
  const query = useQuery({
    queryKey: queryKeys.navigation.publications(menu.id),
    queryFn: () => getNavigationPublications({ data: { menuId: menu.id, limit: 50 } }),
    enabled: open,
  });
  const mutation = useMutation({
    mutationFn: (sourceRevision: number) =>
      rollbackNavigationMenuAuthority({
        data: { menuId: menu.id, expectedRevision: menu.revision, sourceRevision },
      }),
    onSuccess: () => {
      toast.success("Earlier version restored as a new publication");
      setRestoreRevision(null);
      onRestored();
    },
    onError: (error) =>
      toast.error("Menu version was not restored", {
        description: getServerFnError(error, "Menu version was not restored"),
      }),
  });

  const publications = query.data?.items ?? [];

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      width="sm"
      title="Publication history"
      description="Restoring an earlier version publishes it again as the newest revision."
    >
      <div className="divide-y divide-border rounded-lg border border-border">
        {query.isLoading ? (
          <div className="space-y-3 p-3" role="status" aria-busy="true">
            <span className="sr-only">Loading publication history</span>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : null}
        {query.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm text-destructive">
            <span>Publication history could not be loaded.</span>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {publications.map((publication) => {
          const isLive = publication.revision === menu.publishedRevision;
          return (
            <div
              key={publication.revision}
              data-testid="navigation-publication-row"
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                  {isLive ? (
                    <Check className="size-4" aria-hidden />
                  ) : (
                    <Clock3 className="size-4 text-muted-foreground" aria-hidden />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">Revision {publication.revision}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {publication.itemCount} items · {formatDateTime(publication.publishedAt)}
                  </p>
                </div>
              </div>
              {isLive ? (
                <StatusBadge tone="success" srLabel="Publication status:">Live</StatusBadge>
              ) : restoreRevision === publication.revision ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    onClick={() => setRestoreRevision(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="min-h-11 sm:min-h-9"
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate(publication.revision)}
                  >
                    {mutation.isPending ? "Restoring" : "Restore"}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => setRestoreRevision(publication.revision)}
                >
                  Restore this version
                </Button>
              )}
            </div>
          );
        })}
        {!query.isLoading && !query.isError && !publications.length ? (
          <EmptyState
            compact
            bordered={false}
            icon={Clock3}
            heading="Nothing published yet"
            body="Publish this menu to start its history."
          />
        ) : null}
      </div>
    </EditorSheet>
  );
}

export default NavigationHistorySheet;
