import { useCallback, useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { MediaApiClient } from "../api";
import { encodeMediaVariants } from "../utils/media-variants";

const COUNT_LIMIT = 100;
const PAGE_SIZE = 20;

/**
 * Generates the WebP renditions for images uploaded before they existed, with
 * the same browser pipeline as new uploads. Images without renditions keep
 * serving their original until this runs.
 */
export function OptimizeImagesButton({ onOptimized }: { onOptimized: () => void }) {
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
    let cursor: string | undefined;
    setDone(0);
    try {
      do {
        const page = await MediaApiClient.fetchFilesMissingVariants(cursor, PAGE_SIZE);
        for (const file of page.files) {
          try {
            const variants = await encodeMediaVariants(await MediaApiClient.fetchOriginal(file.id));
            if (!variants) throw new Error("This browser cannot encode WebP.");
            await MediaApiClient.saveVariants(file.id, variants);
            optimized += 1;
          } catch {
            failed += 1;
          }
          setDone(optimized + failed);
        }
        cursor = page.pagination.hasMore ? page.pagination.nextCursor ?? undefined : undefined;
      } while (cursor);
    } catch {
      failed += 1;
    }
    if (failed) {
      toast.error(`${optimized} optimized, ${failed} not optimized`, {
        description: "Those keep serving their original. Try again in a current Chrome, Edge, or Firefox.",
      });
    } else {
      toast.success(`${optimized} image${optimized === 1 ? "" : "s"} optimized`);
    }
    setDone(null);
    onOptimized();
    await countPending();
  };

  return (
    <Button type="button" variant="outline" size="sm" className="h-11 text-xs sm:h-7" disabled={done !== null} onClick={() => void optimize()}>
      {done !== null
        ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Optimizing… {done} done</>
        : <><Sparkles className="mr-1.5 h-3.5 w-3.5" />Optimize {pending?.count}{pending?.more ? "+" : ""} image{pending?.count === 1 && !pending.more ? "" : "s"}</>}
    </Button>
  );
}
