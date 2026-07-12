import { AlertCircle, Check, Pause, Play, RotateCcw, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import type { UploadQueueItem } from "../types";

interface MediaUploadQueueProps {
  queue: UploadQueueItem[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onClearFinished: () => void;
}

const statusLabel: Record<UploadQueueItem["status"], string> = {
  queued: "Waiting",
  initiating: "Starting",
  uploading: "Uploading",
  paused: "Paused",
  completing: "Finalizing",
  complete: "Ready",
  failed: "Needs attention",
  cancelled: "Cancelled",
};

export function MediaUploadQueue({ queue, onPause, onResume, onCancel, onClearFinished }: MediaUploadQueueProps) {
  if (!queue.length) return null;
  const finished = queue.some((item) => item.status === "complete" || item.status === "cancelled");
  const activeCount = queue.filter((item) => ["queued", "initiating", "uploading", "completing"].includes(item.status)).length;
  const completeCount = queue.filter((item) => item.status === "complete").length;
  const attentionCount = queue.filter((item) => item.status === "failed").length;
  return (
    <section aria-label="Upload queue" className="border-b bg-muted/20 px-3 py-2">
      <p className="sr-only" aria-live="polite">{activeCount ? `${activeCount} uploads in progress.` : "No uploads in progress."} {completeCount ? `${completeCount} uploads ready.` : ""} {attentionCount ? `${attentionCount} uploads need attention.` : ""}</p>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-xs font-semibold">Uploads <span className="font-normal text-muted-foreground">· 5 MiB resumable parts</span></p>
        {finished && <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onClearFinished}>Clear finished</Button>}
      </div>
      <div className="grid gap-1.5 lg:grid-cols-2">
        {queue.map((item) => (
          <div key={item.id} className="rounded-md border bg-background px-2.5 py-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2"><p className="truncate text-xs font-medium">{item.file.name}</p><span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel[item.status]}</span></div>
                <Progress className="mt-1.5 h-1" value={item.progress} aria-label={`${item.file.name} upload progress`} />
              </div>
              {["initiating", "uploading"].includes(item.status) && <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => onPause(item.id)} aria-label={`Pause ${item.file.name}`}><Pause className="h-3.5 w-3.5" /></Button>}
              {["paused", "failed"].includes(item.status) && <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => onResume(item.id)} aria-label={`${item.status === "failed" ? "Retry" : "Resume"} ${item.file.name}`}>{item.status === "failed" ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>}
              {item.status === "complete" ? <Check className="h-4 w-4 text-emerald-600" /> : !["cancelled", "completing"].includes(item.status) && <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => onCancel(item.id)} aria-label={`Cancel ${item.file.name}`}><X className="h-3.5 w-3.5" /></Button>}
            </div>
            {item.error && <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-4 text-destructive"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />{item.failedPart ? `Part ${item.failedPart}: ` : ""}{item.error}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
