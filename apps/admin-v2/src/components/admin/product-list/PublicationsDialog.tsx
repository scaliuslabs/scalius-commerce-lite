// The products list's "Make available / unavailable on channels" (Shopify's
// bulk publish): choose channels, then the selected products are published
// to or unpublished from them, 90 products per call, or every product the
// list's filter matches, one server slice at a time.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { inChunks, type BulkRun } from "~/components/admin/resource/ResourceListPage";
import type { BulkTarget } from "~/lib/bulk-selection";
import { useMessages } from "~/i18n";
import { salesChannelsMessages } from "~/i18n/sales-channels";
import { getServerFnError } from "~/lib/api-helpers";
import {
  publicationInvalidations,
  salesChannelName,
  salesChannelsQueryOptions,
  setProductPublications,
} from "~/lib/api-query-options/sales-channels";

export function PublicationsDialog({ action, target, filter, bulk, onClose, onDone }: {
  action: "publish" | "unpublish";
  target: BulkTarget<{ id: string }>;
  /** The list's filter, for a `matching` target. */
  filter: Record<string, unknown>;
  bulk: BulkRun;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useMessages(salesChannelsMessages);
  const queryClient = useQueryClient();
  const { data: channels, isError } = useQuery(salesChannelsQueryOptions());
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const count = target.kind === "rows" ? target.rows.length : target.count;

  const run = useMutation({
    mutationFn: async () => {
      if (target.kind === "rows") {
        await inChunks(target.rows.map((row) => row.id), (chunk) => setProductPublications({ action, productIds: chunk, channelIds: chosen }));
        return;
      }
      // Every matching product: the dialog closes and the bulk bar shows the progress.
      onClose();
      await bulk.matching(t(action === "publish" ? "makingAvailable" : "makingUnavailable"), async (cursor) => {
        const result = await setProductPublications({ action, channelIds: chosen, matching: { filter, ...(cursor ? { cursor } : {}) } });
        return result.matching ?? { processed: 0, skipped: 0, next: null };
      });
    },
    onSuccess: () => {
      toast.success(t(action === "publish" ? "published" : "unpublished"));
      onDone();
    },
    onError: (failure) => setError(getServerFnError(failure, t("saveFailed"))),
    onSettled: () => {
      for (const queryKey of publicationInvalidations()) void queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !run.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(action === "publish" ? "publishTitle" : "unpublishTitle", { count })}</DialogTitle>
          <DialogDescription>{t(action === "publish" ? "publishHelp" : "unpublishHelp")}</DialogDescription>
        </DialogHeader>
        {isError ? <p className="text-body text-destructive">{t("loadFailed")}</p> : !channels ? <Skeleton className="h-24 w-full" /> : (
          <ul className="space-y-2">
            {channels.map((channel) => (
              <li key={channel.id}>
                <label className="flex items-start gap-3 text-body">
                  <Checkbox
                    checked={chosen.includes(channel.id)}
                    disabled={run.isPending}
                    onCheckedChange={(checked) => {
                      setError(null);
                      setChosen((current) => checked === true ? [...current, channel.id] : current.filter((entry) => entry !== channel.id));
                    }}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 break-words">
                    {salesChannelName(channel)}
                    {channel.status === "active" ? null : <span className="text-muted-foreground"> · {t("channelOff")}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={run.isPending} onClick={onClose}>{t("cancel")}</Button>
          <Button
            type="button"
            loading={run.isPending}
            onClick={() => (chosen.length === 0 ? setError(t("chooseChannels")) : run.mutate())}
          >
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
