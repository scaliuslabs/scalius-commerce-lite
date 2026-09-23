import { AlertCircle, Check, Pause, Play, RotateCcw, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import type { UploadQueueItem } from "../types";

interface MediaUploadQueueProps {
  queue: UploadQueueItem[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onClearFinished: () => void;
}

const STATUS_KEYS = {
  queued: "statusQueued",
  initiating: "statusStarting",
  uploading: "statusUploading",
  paused: "statusPaused",
  completing: "statusFinishing",
  complete: "statusDone",
  failed: "statusFailed",
  cancelled: "statusCancelled",
} as const satisfies Record<UploadQueueItem["status"], string>;

const ACTIVE = new Set<UploadQueueItem["status"]>(["queued", "initiating", "uploading", "completing"]);

/** Upload progress for each file; resumable uploads keep their place across pause and retry. */
export function MediaUploadQueue({ queue, onPause, onResume, onCancel, onClearFinished }: MediaUploadQueueProps) {
  const t = useMessages(mediaMessages);
  if (!queue.length) return null;
  const count = (test: (item: UploadQueueItem) => boolean) => queue.filter(test).length;
  const active = count((item) => ACTIVE.has(item.status));
  const complete = count((item) => item.status === "complete");
  const failed = count((item) => item.status === "failed");
  const finished = queue.some((item) => item.status === "complete" || item.status === "cancelled");
  const announce = [
    active === 1 ? t("activeOne") : active ? t("activeMany", { count: active }) : t("activeNone"),
    complete === 1 ? t("doneOne") : complete ? t("doneMany", { count: complete }) : "",
    failed === 1 ? t("failedOne") : failed ? t("failedMany", { count: failed }) : "",
  ].filter(Boolean).join(" ");

  return (
    <section aria-label={t("uploads")} className="border-b px-3 py-2">
      <p className="sr-only" aria-live="polite">{announce}</p>
      <div className="flex min-h-9 items-center justify-between gap-2">
        <p className="text-body">
          <span className="font-medium">{t("uploads")}</span>
          {active ? <span className="text-muted-foreground"> · {t("keepTabOpen")}</span> : null}
        </p>
        {finished ? <Button type="button" variant="ghost" size="sm" onClick={onClearFinished}>{t("clearFinished")}</Button> : null}
      </div>
      <ul className="grid gap-2 lg:grid-cols-2">
        {queue.map((item) => (
          <li key={item.id} className="flex flex-col gap-1.5 rounded-lg border px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-baseline gap-2 text-body">
                  <span className="min-w-0 flex-1 truncate font-medium">{item.file.name}</span>
                  <span className="shrink-0 text-muted-foreground">{t(STATUS_KEYS[item.status])}</span>
                </div>
                <Progress value={item.progress} aria-label={t("progressFor", { name: item.file.name })} />
              </div>
              {item.status === "initiating" || item.status === "uploading" ? (
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => onPause(item.id)} aria-label={t("pauseFile", { name: item.file.name })}>
                  <Pause aria-hidden="true" />
                </Button>
              ) : null}
              {item.status === "paused" || item.status === "failed" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onResume(item.id)}
                  aria-label={t(item.status === "failed" ? "retryFile" : "resumeFile", { name: item.file.name })}
                >
                  {item.status === "failed" ? <RotateCcw aria-hidden="true" /> : <Play aria-hidden="true" />}
                </Button>
              ) : null}
              {item.status === "complete" ? (
                <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : item.status !== "cancelled" && item.status !== "completing" ? (
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => onCancel(item.id)} aria-label={t("cancelFile", { name: item.file.name })}>
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            {item.error ? (
              <p className="flex items-start gap-1.5 text-body text-destructive">
                <span className="flex h-lh items-center"><AlertCircle className="size-4 shrink-0" aria-hidden="true" /></span>
                {item.error}
              </p>
            ) : null}
            {item.warning ? (
              <p className="flex items-start gap-1.5 text-body text-warning" role="status">
                <span className="flex h-lh items-center"><AlertCircle className="size-4 shrink-0" aria-hidden="true" /></span>
                {item.warning}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
