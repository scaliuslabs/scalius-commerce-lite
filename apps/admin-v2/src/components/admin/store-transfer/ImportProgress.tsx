import { Download } from "lucide-react";
import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import { formatNumber, useMessages } from "~/i18n";
import { storeTransferMessages } from "~/i18n/store-transfer";

export interface ImportCounts {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export interface ImageFailure {
  url: string;
  message: string | null;
}

/** A running import: what is being sent, how far it got, and a way to stop between batches. */
export function ImportRunning({ label, done, total, stopping }: { label: string; done: number; total: number; stopping: boolean }) {
  const t = useMessages(storeTransferMessages);
  return (
    <div className="space-y-3" aria-live="polite">
      <Progress value={total ? (done / total) * 100 : 0} aria-label={label} />
      <p className="text-body">{label}</p>
      <p className="text-body text-muted-foreground">{stopping ? t("stopping") : t("keepOpen")}</p>
    </div>
  );
}

/** What an import did. */
export function ImportDone({
  counts,
  images,
  stopped,
  error,
  processed,
  total,
  onRetryImages,
  retrying,
  onDownloadReport,
  problems = [],
}: {
  counts: ImportCounts;
  images: { attached: number; failures: readonly ImageFailure[] } | null;
  stopped: boolean;
  error: string | null;
  processed: number;
  total: number;
  onRetryImages?: () => void;
  retrying?: boolean;
  onDownloadReport?: () => void;
  /** Rows that were not imported, with the reason (the report holds every one). */
  problems?: readonly { line: number | null; subject?: string | null; message: string }[];
}) {
  const t = useMessages(storeTransferMessages);
  const rows: Array<[string, number]> = [
    [t("resultCreated"), counts.created],
    [t("resultUpdated"), counts.updated],
    [t("resultUnchanged"), counts.unchanged],
    [t("resultSkipped"), counts.skipped],
    [t("resultFailed"), counts.failed],
  ];
  return (
    <div className="space-y-4" data-testid="import-done">
      {error ? <Alert variant="destructive">{t("runFailed", { message: error })}</Alert> : null}
      {stopped && !error ? <Alert variant="warning">{t("stoppedBody", { done: processed, total })}</Alert> : null}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border px-3 py-2">
            <dd className="text-heading-md tabular-nums">{formatNumber(value)}</dd>
            <dt className="text-body text-muted-foreground">{label}</dt>
          </div>
        ))}
      </dl>
      {images ? (
        <div className="space-y-2">
          <p className="text-body">{t("imagesResult", { attached: images.attached, failed: images.failures.length })}</p>
          {images.failures.length > 0 ? (
            <>
              <p className="text-body font-medium">{t("imageFailures")}</p>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {images.failures.slice(0, 50).map((failure) => (
                  <li key={failure.url} className="text-body">
                    <span className="block truncate font-mono">{failure.url}</span>
                    {failure.message ? <span className="block text-muted-foreground">{failure.message}</span> : null}
                  </li>
                ))}
              </ul>
              {onRetryImages ? (
                <Button type="button" variant="outline" size="sm" loading={retrying} onClick={onRetryImages}>{t("retryImages")}</Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {problems.length > 0 ? (
        <div className="space-y-2">
          <p className="text-body font-medium">{t("rowProblems")}</p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {problems.slice(0, 50).map((problem, index) => (
              <li key={`${problem.line ?? "file"}-${index}`} className="text-body">
                <span className="text-muted-foreground">{problem.line ? t("rowLine", { line: problem.line }) : null}{problem.line && problem.subject ? " · " : null}{problem.subject ? <code>{problem.subject}</code> : null}</span>
                <span className="block">{problem.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {onDownloadReport ? (
        <Button type="button" variant="outline" size="sm" onClick={onDownloadReport}>
          <Download className="size-4" aria-hidden="true" />
          {t("downloadReport")}
        </Button>
      ) : null}
    </div>
  );
}
