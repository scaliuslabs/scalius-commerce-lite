import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "~/lib/toast";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { MediaApiClient } from "../api";
import { renderPendingRenditions } from "../utils/render-pending-renditions";

const COUNT_LIMIT = 100;

/**
 * Renders the pending WebP renditions now, with the same browser pipeline as
 * new uploads, instead of waiting for the background pass
 * (PendingRenditionsLoader). Images without renditions keep serving their
 * original until they are done.
 */
export function OptimizeImagesButton({ onOptimized }: { onOptimized: () => void }) {
  const t = useMessages(mediaMessages);
  const [pending, setPending] = useState<{ count: number; more: boolean } | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const countPending = useCallback(async () => {
    try {
      const page = await MediaApiClient.fetchFilesMissingVariants(undefined, COUNT_LIMIT);
      setPending({ count: page.files.length, more: page.pagination.hasMore });
    } catch {
      setPending(null);
    }
  }, []);

  useEffect(() => { void countPending(); }, [countPending]);

  if (!pending?.count && done === null) return null;

  const optimize = async () => {
    let optimized = 0;
    let failed = 0;
    setDone(0);
    try {
      await renderPendingRenditions({
        limit: Number.POSITIVE_INFINITY,
        skip: new Set(),
        onImage: (outcome) => {
          if (outcome === "rendered") optimized += 1;
          else failed += 1;
          setDone(optimized + failed);
        },
      });
    } catch {
      failed += 1;
    }
    if (failed) {
      toast.error(t("optimizePartial", { done: optimized, failed }), { description: t("optimizePartialHelp") });
    } else {
      toast.success(optimized === 1 ? t("optimizedOne") : t("optimizedMany", { count: optimized }));
    }
    setDone(null);
    onOptimized();
    await countPending();
  };

  const count = pending?.count ?? 0;
  return (
    <Button type="button" variant="outline" disabled={done !== null} aria-busy={done !== null || undefined} onClick={() => void optimize()}>
      <Sparkles aria-hidden="true" />
      {done !== null
        ? t("optimizing", { count: done })
        : pending?.more
          ? t("optimizeMore", { count })
          : count === 1
            ? t("optimizeOne")
            : t("optimizeMany", { count })}
    </Button>
  );
}
