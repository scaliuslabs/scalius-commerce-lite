import { ChevronDown, Download } from "lucide-react";
import type { ImportIssue, UnsupportedSummary } from "@scalius/shared/store-transfer/issues";
import type { ExtraOptionStrategy } from "@scalius/shared/store-transfer/product-mapping";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Label } from "~/components/ui/label";
import { Progress } from "~/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Checkbox } from "~/components/ui/checkbox";
import { Alert } from "~/components/ui/alert";
import { formatNumber, useLocale, useMessages } from "~/i18n";
import { importIssueMessages, storeTransferMessages } from "~/i18n/store-transfer";

/** Problems shown inline; the rest are in the downloadable report. */
export const PREVIEW_ISSUE_LIMIT = 50;

export interface PreviewStats {
  create: number;
  update: number;
  skip: number;
  failed: number;
}

export interface ImportPreviewProps {
  /** "Shopify product CSV · 412 rows". */
  heading: string;
  /** "6 products · 22 variants · 9 images". */
  summary: string;
  stats: PreviewStats;
  /** Server dry run still running: done of total items. */
  checking: { done: number; total: number } | null;
  notes: readonly string[];
  warning?: string | null;
  extraOptions?: { count: number; value: ExtraOptionStrategy; onChange: (value: ExtraOptionStrategy) => void } | null;
  roundPrices?: { count: number; value: boolean; onChange: (value: boolean) => void } | null;
  unsupported: readonly UnsupportedSummary[];
  issues: readonly ImportIssue[];
  onDownloadReport: () => void;
  onDownloadFailedRows: () => void;
}

const hasKey = (catalog: { en: object }, key: string) => Object.prototype.hasOwnProperty.call(catalog.en, key);

/** One issue in the dashboard language: the file's own wording in English, the explained code in Bangla. */
export function useIssueText() {
  const locale = useLocale();
  const explain = useMessages(importIssueMessages);
  return (issue: Pick<ImportIssue, "code" | "message">) => {
    if (locale === "en" || !hasKey(importIssueMessages, issue.code)) return issue.message;
    return explain(issue.code as Parameters<typeof explain>[0]);
  };
}

/** "Product tags (use collections…)" for an unsupported-summary code. */
export function useUnsupportedLabel() {
  const t = useMessages(storeTransferMessages);
  return (entry: Pick<UnsupportedSummary, "code" | "message">) => {
    const key = `unsupported_${entry.code}`;
    return hasKey(storeTransferMessages, key) ? t(key as Parameters<typeof t>[0]) : entry.message;
  };
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "critical" }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className={tone === "critical" && value > 0 ? "text-heading-md tabular-nums text-critical" : "text-heading-md tabular-nums"}>{formatNumber(value)}</p>
      <p className="text-body text-muted-foreground">{label}</p>
    </div>
  );
}

/** What an import will do, before anything is written. */
export function ImportPreview(props: ImportPreviewProps) {
  const t = useMessages(storeTransferMessages);
  const issueText = useIssueText();
  const errors = props.issues.filter((issue) => issue.severity === "error");
  const warnings = props.issues.length - errors.length;
  const errorLines = new Set(errors.map((issue) => issue.line ?? -1)).size;
  const shown = props.issues.slice(0, PREVIEW_ISSUE_LIMIT);
  const unsupportedLabel = useUnsupportedLabel();

  return (
    <div className="space-y-4" data-testid="import-preview">
      <div className="space-y-1">
        <p className="text-body font-medium">{props.heading}</p>
        <p className="text-body text-muted-foreground">{props.summary}</p>
      </div>

      {props.checking ? (
        <div className="space-y-1.5" aria-live="polite">
          <Progress value={props.checking.total ? (props.checking.done / props.checking.total) * 100 : 0} aria-label={t("checking", { done: props.checking.done, total: props.checking.total })} />
          <p className="text-body text-muted-foreground">{t("checking", { done: props.checking.done, total: props.checking.total })}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t("statCreate")} value={props.stats.create} />
          <Stat label={t("statUpdate")} value={props.stats.update} />
          <Stat label={t("statSkip")} value={props.stats.skip} />
          <Stat label={t("statFailed")} value={props.stats.failed} tone="critical" />
        </div>
      )}

      {props.warning ? <Alert variant="warning">{props.warning}</Alert> : null}
      {props.notes.length > 0 ? (
        <ul className="space-y-1">
          {props.notes.map((note) => <li key={note} className="text-body text-muted-foreground">{note}</li>)}
        </ul>
      ) : null}

      {props.extraOptions && props.extraOptions.count > 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-body font-medium">{t("option3Title", { count: props.extraOptions.count })}</legend>
          <RadioGroup value={props.extraOptions.value} onValueChange={(value) => props.extraOptions!.onChange(value as ExtraOptionStrategy)}>
            {([
              ["keep", t("option3Keep"), t("option3KeepHelp")],
              ["skip", t("option3Skip"), t("option3SkipHelp")],
              ["fold", t("option3Fold"), t("option3FoldHelp")],
            ] as const).map(([value, label, help]) => (
              <div key={value} className="flex items-start gap-2">
                <span className="flex h-lh items-center"><RadioGroupItem id={`import-option3-${value}`} value={value} aria-describedby={`import-option3-${value}-help`} /></span>
                <div className="space-y-0.5">
                  <Label htmlFor={`import-option3-${value}`}>{label}</Label>
                  <p id={`import-option3-${value}-help`} className="text-body text-muted-foreground">{help}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
      ) : null}

      {props.roundPrices && props.roundPrices.count > 0 ? (
        <div className="flex items-start gap-2">
          <span className="flex h-lh items-center">
            <Checkbox id="import-round-prices" checked={props.roundPrices.value} onCheckedChange={(checked) => props.roundPrices!.onChange(checked === true)} aria-describedby="import-round-prices-help" />
          </span>
          <div className="space-y-0.5">
            <Label htmlFor="import-round-prices">{t("roundPrices")}</Label>
            <p id="import-round-prices-help" className="text-body text-muted-foreground">{t("roundPricesHelp", { count: props.roundPrices.count })}</p>
          </div>
        </div>
      ) : null}

      {props.unsupported.length > 0 ? (
        <div className="border-t border-border pt-3">
          <Collapsible>
            <CollapsibleTrigger asChild>
              <button type="button" className="group flex min-h-11 w-full items-center justify-between gap-2 rounded-lg text-start text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8">
                <span>{t("cantImport")}</span>
                <ChevronDown className="size-4 text-muted-foreground group-data-[state=open]:rotate-180" aria-hidden="true" />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 space-y-2">
                {props.unsupported.map((entry) => (
                  <li key={entry.code} className="flex items-start justify-between gap-3 text-body">
                    <span className="min-w-0">
                      {unsupportedLabel(entry)}
                      {entry.examples.length > 0 ? (
                        <span className="block truncate text-muted-foreground">{entry.examples.join(", ")}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{t("cantImportCount", { count: entry.count })}</span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}

      {props.issues.length > 0 ? (
        <section className="space-y-2 border-t border-border pt-3" aria-label={t("problems")}>
          <div className="space-y-0.5">
            <h3 className="text-heading-sm">{t("problems")}</h3>
            <p className="text-body text-muted-foreground">{t("problemsCount", { errors: errorLines, warnings })}</p>
          </div>
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {shown.map((issue, index) => (
              <li key={`${issue.line}-${issue.code}-${index}`} className="flex items-start gap-2 text-body">
                <Badge variant={issue.severity === "error" ? "destructive" : "warning"} className="shrink-0">
                  {issue.line ? t("lineLabel", { line: issue.line }) : issue.severity}
                </Badge>
                <span className="min-w-0 break-words">
                  {issue.subject ? <code className="me-1">{issue.subject}</code> : null}
                  {issueText(issue)}
                </span>
              </li>
            ))}
          </ul>
          {props.issues.length > shown.length ? (
            <p className="text-body text-muted-foreground">{t("moreProblems", { count: props.issues.length - shown.length })}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={props.onDownloadReport}>
              <Download className="size-4" aria-hidden="true" />
              {t("downloadReport")}
            </Button>
            {errors.length > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={props.onDownloadFailedRows}>
                <Download className="size-4" aria-hidden="true" />
                {t("downloadFailedRows")}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
