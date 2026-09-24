import { AlertCircle, Check, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import type { UploadQueueItem } from "../types";

interface MediaUploadQueueProps {
  queue: UploadQueueItem[];
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}

/** One row per file: live progress, a plain reason when it fails, gone once it's uploaded. */
export function MediaUploadQueue({ queue, onRetry, onDismiss }: MediaUploadQueueProps) {
  const t = useMessages(mediaMessages);
  if (!queue.length) return null;
  const count = (...statuses: UploadQueueItem["status"][]) => queue.filter((item) => statuses.includes(item.status)).length;
  const active = count("queued", "uploading", "processing");
  const done = count("done");
  const failed = count("failed");
  const announce = [
    active === 1 ? t("activeOne") : active ? t("activeMany", { count: active }) : t("activeNone"),
    done === 1 ? t("doneOne") : done ? t("doneMany", { count: done }) : "",
    failed === 1 ? t("failedOne") : failed ? t("failedMany", { count: failed }) : "",
  ].filter(Boolean).join(" ");

  return (
    <section aria-label={t("uploads")} className="border-b px-3 py-2">
      <p className="sr-only" aria-live="polite">{announce}</p>
      <p className="flex min-h-9 items-center text-body">
        <span className="font-medium">{t("uploads")}</span>
        {active ? <span className="text-muted-foreground">&nbsp;· {t("keepTabOpen")}</span> : null}
      </p>
      <ul className="grid gap-2 lg:grid-cols-2">
        {queue.map((item) => {
          const name = item.file.name;
          const status = item.status === "uploading"
            ? t("statusUploading", { percent: item.progress })
            : item.status === "queued" ? t("statusQueued")
            : item.status === "processing" ? t("statusProcessing")
            : item.status === "done" ? t("statusDone")
            : null;
          return (
            <li key={item.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-baseline gap-2 text-body">
                  <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                  {status ? <span className="shrink-0 text-muted-foreground">{status}</span> : null}
                </div>
                {item.status === "failed" && item.error ? (
                  <p className="flex items-start gap-1.5 text-body text-destructive">
                    <span className="flex h-lh items-center"><AlertCircle className="size-4 shrink-0" aria-hidden="true" /></span>
                    {t(item.error)}
                  </p>
                ) : item.warning ? (
                  <p className="flex items-start gap-1.5 text-body text-warning">
                    <span className="flex h-lh items-center"><AlertCircle className="size-4 shrink-0" aria-hidden="true" /></span>
                    {t(item.warning)}
                  </p>
                ) : item.status !== "done" ? (
                  <Progress value={item.progress} aria-label={t("progressFor", { name })} />
                ) : null}
              </div>
              {item.error === "failed" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => onRetry(item.id)} aria-label={t("retryFile", { name })}>
                  {t("retry")}
                </Button>
              ) : null}
              {item.status === "failed" ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => onDismiss(item.id)} aria-label={t("removeFile", { name })}>
                  {t("remove")}
                </Button>
              ) : item.status === "done" && !item.warning ? (
                <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : item.status !== "processing" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onDismiss(item.id)}
                  aria-label={t(item.status === "done" ? "removeFile" : "cancelFile", { name })}
                  title={t(item.status === "done" ? "removeFile" : "cancelFile", { name })}
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
