import { useId, useRef, useState, type DragEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Progress } from "~/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { storeTransferMessages } from "~/i18n/store-transfer";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "@scalius/shared/utils";
import { IMPORT_FORMAT_KIND, type ImportFormat } from "@scalius/shared/store-transfer/detect";
import type { ImportKind, ProductImportChoice, CustomerImportChoice } from "./import-plan";
import { ImportPreview } from "./ImportPreview";
import { ImportDone, ImportRunning } from "./ImportProgress";
import { sampleCsv } from "./sample-csv";
import { saveCsv } from "./export-download";
import { INVENTORY_SEARCH_DEFAULTS } from "../inventory/inventory-search";
import { useImportSession } from "./use-import-session";

type MessageKey = keyof typeof storeTransferMessages.en;
type Messages = (key: MessageKey, vars?: Record<string, string | number>) => string;

const formatLabel = (t: Messages, format: ImportFormat) => t(`format_${format}` as MessageKey);

function ModeChoice<T extends string>({ value, onChange, options, label }: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string; help: string }>;
  label: string;
}) {
  const id = useId();
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-body font-medium">{label}</legend>
      <RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
        {options.map((option) => (
          <div key={option.value} className="flex items-start gap-2">
            <span className="flex h-lh items-center">
              <RadioGroupItem id={`${id}-${option.value}`} value={option.value} aria-describedby={`${id}-${option.value}-help`} />
            </span>
            <div className="space-y-0.5">
              <Label htmlFor={`${id}-${option.value}`}>{option.label}</Label>
              <p id={`${id}-${option.value}-help`} className={cn("text-body text-muted-foreground", option.value !== value && "sr-only")}>{option.help}</p>
            </div>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

/**
 * Shopify-style import: choose a CSV, see what will happen (a server dry run
 * on every row), import in batches with live progress, then a summary with a
 * downloadable report. Works for products (create, upsert, prices, stock),
 * customers and inventory counts.
 */
export function ImportDialog({ kind, open, onOpenChange }: { kind: ImportKind; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(storeTransferMessages);
  const r = useMessages(resourceMessages);
  const { code: currencyCode, priceIncrementMinor } = useCurrency();
  const queryClient = useQueryClient();
  const session = useImportSession(kind, currencyCode, priceIncrementMinor);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { fileState, plan, preview, run } = session;
  const running = run.status === "running";

  const title = kind === "customers" ? t("importCustomers") : kind === "inventory" ? t("importInventory") : t("importProducts");
  const close = (next: boolean) => {
    if (next || running) return;
    if (run.status === "done") {
      void queryClient.invalidateQueries({ queryKey: kind === "customers" ? queryKeys.customers.all : queryKeys.products.all });
      if (kind !== "customers") void queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list() });
    }
    session.reset();
    onOpenChange(false);
  };
  const choose = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void session.readFile(file);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files);
  };

  const productModes: ReadonlyArray<{ value: ProductImportChoice; label: string; help: string }> = [
    { value: "create", label: t("modeCreateProducts"), help: t("modeCreateProductsHelp") },
    { value: "upsert", label: t("modeUpsertProducts"), help: t("modeUpsertProductsHelp") },
    { value: "price", label: t("modePrice"), help: t("modePriceHelp") },
    { value: "inventory", label: t("modeInventory"), help: t("modeInventoryHelp") },
  ];
  const customerModes: ReadonlyArray<{ value: CustomerImportChoice; label: string; help: string }> = [
    { value: "create", label: t("modeCreateCustomers"), help: t("modeCreateCustomersHelp") },
    { value: "upsert", label: t("modeUpsertCustomers"), help: t("modeUpsertCustomersHelp") },
  ];

  const fileErrorText = (message: string, line?: number) => {
    const known: Record<string, string> = {
      empty: t("fileEmpty"),
      too_large: t("fileTooLarge"),
      too_many_rows: t("fileTooManyRows"),
      no_header: t("fileNoHeader"),
      unreadable: t("fileUnreadable"),
    };
    return line ? t("fileBroken", { line, message }) : known[message] ?? message;
  };

  const picker = (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border border-dashed border-input px-4 py-6 text-center",
        dragging && "border-ring bg-accent",
      )}
    >
      <FileUp className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-body">{t("dropHint")}</p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/plain"
        className="sr-only"
        aria-label={t("chooseFile")}
        onChange={(event) => {
          choose(event.target.files);
          event.target.value = "";
        }}
      />
      <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>{t("chooseFile")}</Button>
    </div>
  );

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (run.status === "running") {
    const label = run.phase === "images"
      ? t("downloadingImages", { done: run.done, total: run.total })
      : kind === "customers"
        ? t("savingCustomers", { done: run.done, total: run.total })
        : plan?.kind === "inventory"
          ? t("savingCounts", { done: run.done, total: run.total })
          : t("savingProducts", { done: run.done, total: run.total });
    body = <ImportRunning label={label} done={run.done} total={run.total} stopping={run.stopping} />;
    footer = <Button type="button" variant="outline" onClick={session.stop} disabled={run.stopping}>{t("stop")}</Button>;
  } else if (run.status === "done") {
    body = (
      <ImportDone
        counts={session.counts}
        images={plan?.kind === "products" && (run.imageAttached > 0 || run.imageFailures.length > 0) ? { attached: run.imageAttached, failures: run.imageFailures } : null}
        stopped={run.stopped}
        error={run.error}
        processed={run.done}
        total={run.total}
        onRetryImages={run.imageFailures.length > 0 ? () => void session.retryImages() : undefined}
        onDownloadReport={session.issues.length > 0 ? session.downloadReport : undefined}
      />
    );
    footer = (
      <>
        <Button type="button" variant="outline" asChild>
          {kind === "customers"
            ? <Link to="/admin/customers" onClick={() => close(false)}>{t("viewCustomers")}</Link>
            : plan?.kind === "inventory"
              ? <Link to="/admin/inventory" search={INVENTORY_SEARCH_DEFAULTS} onClick={() => close(false)}>{t("viewInventory")}</Link>
              : <Link to="/admin/products" onClick={() => close(false)}>{t("viewProducts")}</Link>}
        </Button>
        <Button type="button" onClick={() => close(false)}>{t("done")}</Button>
      </>
    );
  } else if (fileState.status === "ready" && plan) {
    const fileLine = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate text-body"><span className="text-muted-foreground">{t("fileLabel")}: </span>{fileState.name}</p>
        <Button type="button" variant="link" size="sm" onClick={() => inputRef.current?.click()}>{t("replaceFile")}</Button>
        <input ref={inputRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" aria-label={t("chooseFile")} onChange={(event) => { choose(event.target.files); event.target.value = ""; }} />
      </div>
    );
    const modes = kind === "products"
      ? <ModeChoice label={t("whatToDo")} value={session.options.productMode} onChange={(value) => session.setOption("productMode", value)} options={productModes} />
      : kind === "customers"
        ? <ModeChoice label={t("whatToDo")} value={session.options.customerMode} onChange={(value) => session.setOption("customerMode", value)} options={customerModes} />
        : <p className="text-body text-muted-foreground">{t("inventoryHelp")}</p>;
    if (plan.kind === "unknown") {
      body = (
        <div className="space-y-4">
          {fileLine}
          <Alert variant="warning">
            <p className="font-medium">{t("unknownFormat")}</p>
            <p>{t("unknownFormatBody", { columns: plan.detection.missing.join(", ") })}</p>
          </Alert>
        </div>
      );
      footer = <Button type="button" variant="outline" onClick={() => close(false)}>{r("cancel")}</Button>;
    } else if (plan.kind === "mismatch") {
      body = (
        <div className="space-y-4">
          {fileLine}
          <Alert variant="warning">
            <p className="font-medium">{t("mismatch", { format: formatLabel(t, plan.format) })}</p>
            <p>{IMPORT_FORMAT_KIND[plan.format] === "products"
              ? t("mismatchProducts")
              : IMPORT_FORMAT_KIND[plan.format] === "customers" ? t("mismatchCustomers") : t("mismatchInventory")}</p>
          </Alert>
        </div>
      );
      footer = <Button type="button" variant="outline" onClick={() => close(false)}>{r("cancel")}</Button>;
    } else {
      const notes: string[] = [];
      if (plan.kind === "products") {
        if (preview.references.brands + preview.references.categories + preview.references.attributes > 0) {
          const parts = [
            preview.references.brands ? t("newBrands", { count: preview.references.brands }) : null,
            preview.references.categories ? t("newCategories", { count: preview.references.categories }) : null,
            preview.references.attributes ? t("newAttributes", { count: preview.references.attributes }) : null,
          ].filter(Boolean);
          notes.push(t("newRecords", { list: parts.join(", ") }));
        }
        if (session.imageCount > 0) notes.push(t("imagesNote", { count: session.imageCount }));
        notes.push(t("pricesNote", { currency: currencyCode }));
      }
      if (plan.kind === "customers") {
        notes.push(t("consentNote", {
          email: plan.items.filter((item) => item.marketing.email).length,
          sms: plan.items.filter((item) => item.marketing.sms).length,
        }));
      }
      const summary = plan.kind === "products"
        ? t("summaryProducts", { count: plan.items.length, variants: plan.stats.variants, images: plan.stats.images })
        : plan.kind === "customers"
          ? t("summaryCustomers", { count: plan.items.length })
          : t("summaryCounts", { count: plan.items.length });
      body = (
        <div className="space-y-4">
          {fileLine}
          {modes}
          {preview.error ? <Alert variant="destructive">{t("runFailed", { message: preview.error })}</Alert> : null}
          <ImportPreview
            heading={t("detected", { format: formatLabel(t, plan.format), rows: plan.rows })}
            summary={summary}
            stats={session.stats}
            checking={preview.checking}
            notes={notes}
            warning={fileState.file.encoding === "windows-1252" ? t("encodingWarning") : null}
            extraOptions={plan.kind === "products" ? { count: plan.stats.productsWithExtraOptions, value: session.options.extraOptions, onChange: (value) => session.setOption("extraOptions", value) } : null}
            roundPrices={plan.kind === "products" ? { count: session.fractionalPrices, value: session.options.roundPrices, onChange: (value) => session.setOption("roundPrices", value) } : null}
            unsupported={plan.unsupported}
            issues={session.issues}
            onDownloadReport={session.downloadReport}
            onDownloadFailedRows={session.downloadFailedRows}
          />
        </div>
      );
      const count = session.writable.length;
      const startLabel = count === 0 && session.imageCount > 0
        ? t("startImages")
        : plan.kind === "customers"
          ? t("startCustomers", { count })
          : plan.kind === "inventory"
            ? t("startCounts", { count })
            : plan.mode === "price"
              ? t("startPrices", { count })
              : t("startProducts", { count });
      const canStart = !preview.checking && !preview.error && (count > 0 || session.imageCount > 0);
      footer = (
        <>
          <Button type="button" variant="outline" onClick={() => close(false)}>{r("cancel")}</Button>
          <Button type="button" disabled={!canStart} onClick={() => void session.start()}>
            {canStart || preview.checking ? startLabel : t("nothingToImport")}
          </Button>
        </>
      );
    }
  } else {
    const sample = sampleCsv(kind);
    body = (
      <div className="space-y-4">
        {picker}
        {fileState.status === "reading" ? (
          <div className="space-y-1.5" aria-live="polite">
            <Progress value={fileState.size ? (fileState.bytes / fileState.size) * 100 : 0} aria-label={t("reading", { name: fileState.name })} />
            <p className="text-body text-muted-foreground">{t("reading", { name: fileState.name })}</p>
          </div>
        ) : null}
        {fileState.status === "error" ? (
          <Alert variant="destructive">{fileErrorText(fileState.message, fileState.line)}</Alert>
        ) : null}
        <p className="text-body text-muted-foreground">{t("fileHelp")}</p>
        <div>
          <Button type="button" variant="link" size="sm" onClick={() => saveCsv(sample.csv, sample.filename)}>{t("sampleFile")}</Button>
        </div>
      </div>
    );
    footer = <Button type="button" variant="outline" onClick={() => close(false)}>{r("cancel")}</Button>;
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl" onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{run.status === "done" ? (run.stopped || run.error ? t("stoppedTitle") : t("doneTitle")) : title}</DialogTitle>
          <DialogDescription className="sr-only">{t("fileHelp")}</DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
