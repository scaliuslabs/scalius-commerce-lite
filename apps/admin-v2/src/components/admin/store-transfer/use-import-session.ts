// One import in the dashboard, from the chosen file to the finished run:
// reading and mapping the CSV in the browser, the server dry run, the write
// in idempotent batches with the dry run's revisions, and the images after.
// Nothing is kept outside the page: closing it and uploading the same file
// again resumes, because every batch skips what is already done.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  postApiV1AdminImportCustomers,
  postApiV1AdminImportInventory,
  postApiV1AdminImportProductImages,
  postApiV1AdminImportProducts,
} from "@scalius/api-client/sdk";
import { readImportFile, ImportFileError, type ImportFile } from "@scalius/shared/store-transfer/detect";
import { CsvParseError } from "@scalius/shared/store-transfer/csv";
import { buildFailedRowsCsv, buildImportIssuesCsv, type ImportIssue } from "@scalius/shared/store-transfer/issues";
import {
  PRODUCT_IMAGE_BATCH_DEFAULT,
  PRODUCT_IMPORT_BATCH_DEFAULT,
  productImageJobs,
  type ProductImportItem,
} from "@scalius/shared/store-transfer/products";
import { CUSTOMER_IMPORT_BATCH_DEFAULT, type CustomerImportItem } from "@scalius/shared/store-transfer/customers";
import { INVENTORY_IMPORT_BATCH_DEFAULT, type InventoryImportItem } from "@scalius/shared/store-transfer/inventory";
import { apiData } from "~/lib/api";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { planImport, type ImportKind, type ImportPlan, type PlanOptions } from "./import-plan";
import { chunkImageJobs, newImportRunId, runInBatches, runPool, type BatchResponse } from "./import-runner";
import { mergeIssues, serverIssues, type ServerResult } from "./import-issues";
import type { ImageFailure, ImportCounts } from "./ImportProgress";
import { saveCsv } from "./export-download";

type Plannable = Exclude<ImportPlan, { kind: "unknown" | "mismatch" }>;

export interface ItemResult extends ServerResult {
  productId?: string | null;
  customerId?: string | null;
  aggregateRevision?: number | null;
  previousOnHand?: number | null;
}

interface ReferenceTotals {
  brands: Set<string>;
  categories: Set<string>;
  attributes: Set<string>;
}

export type FileState =
  | { status: "empty" }
  | { status: "reading"; name: string; bytes: number; size: number }
  | { status: "error"; name: string; message: string; line?: number }
  | { status: "ready"; name: string; file: ImportFile };

export interface PreviewState {
  checking: { done: number; total: number } | null;
  results: ItemResult[];
  references: { brands: number; categories: number; attributes: number };
  error: string | null;
}

export interface RunState {
  status: "idle" | "running" | "done";
  phase: "items" | "images";
  done: number;
  total: number;
  results: ItemResult[];
  imageAttached: number;
  imageFailures: ImageFailure[];
  stopping: boolean;
  stopped: boolean;
  error: string | null;
}

const IDLE_RUN: RunState = {
  status: "idle", phase: "items", done: 0, total: 0, results: [], imageAttached: 0, imageFailures: [], stopping: false, stopped: false, error: null,
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function fileErrorKey(error: unknown): { message: string; line?: number } {
  if (error instanceof ImportFileError) return { message: error.code };
  if (error instanceof CsvParseError) return { message: error.message, line: error.line };
  return { message: "unreadable" };
}

/** Sends one batch of `kind` items, returning the endpoint's progress fields. */
function sender(plan: Plannable, dryRun: boolean, runId: string, references?: ReferenceTotals) {
  if (plan.kind === "products") {
    return async (items: ProductImportItem[]): Promise<BatchResponse<ItemResult>> => {
      const data = await apiData(postApiV1AdminImportProducts({ body: { mode: plan.mode, dryRun, items } }));
      if (references) {
        data.references.brandsToCreate.forEach((name) => references.brands.add(name.toLowerCase()));
        data.references.categoriesToCreate.forEach((name) => references.categories.add(name.toLowerCase()));
        data.references.attributesToCreate.forEach((name) => references.attributes.add(name.toLowerCase()));
      }
      return data as unknown as BatchResponse<ItemResult>;
    };
  }
  if (plan.kind === "customers") {
    return async (items: CustomerImportItem[]): Promise<BatchResponse<ItemResult>> =>
      (await apiData(postApiV1AdminImportCustomers({ body: { mode: plan.mode, dryRun, items } }))) as unknown as BatchResponse<ItemResult>;
  }
  return async (items: InventoryImportItem[]): Promise<BatchResponse<ItemResult>> =>
    (await apiData(postApiV1AdminImportInventory({ body: { dryRun, runId, items } }))) as unknown as BatchResponse<ItemResult>;
}

const BATCH_SIZE: Record<Plannable["kind"], number> = {
  products: PRODUCT_IMPORT_BATCH_DEFAULT,
  customers: CUSTOMER_IMPORT_BATCH_DEFAULT,
  inventory: INVENTORY_IMPORT_BATCH_DEFAULT,
};

/** `priceIncrementMinor`: the store's (Settings → Store details); imported prices are multiples of it. */
export function useImportSession(kind: ImportKind, currencyCode: string, priceIncrementMinor: number) {
  const [fileState, setFileState] = useState<FileState>({ status: "empty" });
  const [options, setOptions] = useState<Omit<PlanOptions, "kind" | "currency">>({
    // As in Shopify, an import adds what is new and leaves the store's own records alone until asked.
    productMode: kind === "inventory" ? "inventory" : "create",
    customerMode: "create",
    extraOptions: "keep",
    roundPrices: false,
    categorySource: "auto",
  });
  const [preview, setPreview] = useState<PreviewState>({ checking: null, results: [], references: { brands: 0, categories: 0, attributes: 0 }, error: null });
  const [run, setRun] = useState<RunState>(IDLE_RUN);
  const previewAbort = useRef<AbortController | null>(null);
  const runAbort = useRef<AbortController | null>(null);
  const runId = useRef(newImportRunId());
  const currency = useMemo(
    () => ({ code: currencyCode, decimalPlaces: getDecimalPlaces(currencyCode), priceIncrementMinor }),
    [currencyCode, priceIncrementMinor],
  );

  const plan = useMemo<ImportPlan | null>(() => {
    if (fileState.status !== "ready") return null;
    return planImport(fileState.file, { ...options, kind, currency });
  }, [fileState, options, kind, currency]);

  // Prices with paisa in a taka store. Counted while rounding is off and kept
  // while it is on, so the checkbox that turned it on stays visible.
  const fractionalNow = plan && "issues" in plan
    ? plan.issues.filter((issue) => issue.code === "price_not_whole_taka" || issue.code === "price_too_precise").length
    : 0;
  const [fractionalPrices, setFractionalPrices] = useState(0);
  useEffect(() => {
    if (!options.roundPrices) setFractionalPrices(fractionalNow);
  }, [fractionalNow, options.roundPrices]);

  const readFile = useCallback(async (file: File) => {
    previewAbort.current?.abort();
    setRun(IDLE_RUN);
    setFileState({ status: "reading", name: file.name, bytes: 0, size: file.size });
    try {
      const parsed = await readImportFile(file, {
        onProgress: (bytes) => setFileState((current) => current.status === "reading" ? { ...current, bytes } : current),
      });
      runId.current = newImportRunId();
      setFileState({ status: "ready", name: file.name, file: parsed });
    } catch (error) {
      setFileState({ status: "error", name: file.name, ...fileErrorKey(error) });
    }
  }, []);

  const reset = useCallback(() => {
    previewAbort.current?.abort();
    runAbort.current?.abort();
    setFileState({ status: "empty" });
    setRun(IDLE_RUN);
    setPreview({ checking: null, results: [], references: { brands: 0, categories: 0, attributes: 0 }, error: null });
  }, []);

  // The server dry run, again whenever the plan changes (an option was chosen).
  useEffect(() => {
    previewAbort.current?.abort();
    if (!plan || plan.kind === "unknown" || plan.kind === "mismatch" || plan.items.length === 0) {
      setPreview({ checking: null, results: [], references: { brands: 0, categories: 0, attributes: 0 }, error: null });
      return;
    }
    const controller = new AbortController();
    previewAbort.current = controller;
    const references: ReferenceTotals = { brands: new Set(), categories: new Set(), attributes: new Set() };
    const items = plan.items as unknown[];
    setPreview({ checking: { done: 0, total: items.length }, results: [], references: { brands: 0, categories: 0, attributes: 0 }, error: null });
    const send = sender(plan, true, runId.current, references) as (batch: unknown[]) => Promise<BatchResponse<ItemResult>>;
    void runInBatches(items, {
      send,
      size: BATCH_SIZE[plan.kind] * 2,
      signal: controller.signal,
      onProgress: ({ done, total }) => {
        if (!controller.signal.aborted) setPreview((current) => ({ ...current, checking: { done, total } }));
      },
    }).then(({ results, completed }) => {
      if (controller.signal.aborted || !completed) return;
      setPreview({
        checking: null,
        results,
        references: { brands: references.brands.size, categories: references.categories.size, attributes: references.attributes.size },
        error: null,
      });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setPreview((current) => ({ ...current, checking: null, error: errorMessage(error) }));
    });
    return () => controller.abort();
  }, [plan]);

  const plannable = plan && plan.kind !== "unknown" && plan.kind !== "mismatch" ? plan : null;

  const stats = useMemo(() => {
    const counts = { create: 0, update: 0, skip: 0, failed: 0 };
    if (!plannable) return counts;
    for (const result of preview.results) {
      if (result.status === "would_create") counts.create += 1;
      else if (result.status === "would_update") counts.update += 1;
      else if (result.status === "would_skip") counts.skip += 1;
      else if (result.status === "failed") counts.failed += 1;
    }
    // Rows the mapper refused never reached the server.
    counts.failed += plannable.kind === "products"
      ? plannable.stats.failedProducts
      : new Set(plannable.issues.filter((issue) => issue.severity === "error").map((issue) => issue.line)).size;
    return counts;
  }, [plannable, preview.results]);

  const issues = useMemo<ImportIssue[]>(() => {
    if (!plannable) return [];
    return mergeIssues(plannable.issues, serverIssues(plannable, preview.results), serverIssues(plannable, run.results));
  }, [plannable, preview.results, run.results]);

  /** Items worth sending: what the dry run would create or update, with the revision or count it saw. */
  const writable = useMemo(() => {
    if (!plannable) return [];
    const byRef = new Map(preview.results.map((result) => [result.ref, result]));
    const items = plannable.items as Array<ProductImportItem | CustomerImportItem | InventoryImportItem>;
    return items.flatMap((item) => {
      const result = byRef.get(item.ref);
      if (!result || (result.status !== "would_create" && result.status !== "would_update")) return [];
      if (plannable.kind === "products" && result.status === "would_update" && result.productId && result.aggregateRevision) {
        return [{ ...(item as ProductImportItem), expected: { productId: result.productId, aggregateRevision: result.aggregateRevision } }];
      }
      if (plannable.kind === "inventory" && typeof result.previousOnHand === "number") {
        return [{ ...(item as InventoryImportItem), expectedOnHand: result.previousOnHand }];
      }
      return [item];
    });
  }, [plannable, preview.results]);

  /** Images of products the file names that will be (or already are) in the store. */
  const imageCount = useMemo(() => {
    if (!plannable || plannable.kind !== "products" || plannable.mode === "price") return 0;
    const importable = new Set(preview.results.filter((result) => result.status !== "failed").map((result) => result.ref));
    return plannable.items.reduce((sum, item) => sum + (importable.has(item.ref) ? item.images.length : 0), 0);
  }, [plannable, preview.results]);

  const attachImages = useCallback(async (
    jobs: Array<{ productId: string; images: ReturnType<typeof productImageJobs> }>,
    signal: AbortSignal,
  ) => {
    let pending = chunkImageJobs(jobs, PRODUCT_IMAGE_BATCH_DEFAULT);
    const total = pending.reduce((sum, job) => sum + job.images.length, 0);
    let done = 0;
    let attached = 0;
    const failures: ImageFailure[] = [];
    setRun((current) => ({ ...current, phase: "images", done: 0, total }));
    // Images left pending (the request ran out of time) go round again, a few times at most.
    for (let round = 0; round < 4 && pending.length > 0 && !signal.aborted; round += 1) {
      const again: typeof pending = [];
      await runPool(pending, 3, async (job) => {
        try {
          const data = await apiData(postApiV1AdminImportProductImages({ body: { items: [job] } }));
          const result = data.results[0];
          const retry = job.images.filter((image) => result?.images.find((entry) => entry.url === image.url)?.status === "pending");
          if (retry.length > 0) again.push({ ...job, images: retry });
          for (const image of result?.images ?? []) {
            if (image.status === "pending") continue;
            done += 1;
            if (image.status === "attached") attached += 1;
            if (image.status === "failed") failures.push({ url: image.url, message: image.message ?? result?.error ?? null });
          }
        } catch (error) {
          done += job.images.length;
          failures.push(...job.images.map((image) => ({ url: image.url, message: errorMessage(error) })));
        }
        setRun((current) => ({ ...current, done, imageAttached: attached, imageFailures: [...failures] }));
      }, signal);
      pending = again;
    }
    return { attached, failures };
  }, []);

  const start = useCallback(async () => {
    if (!plannable) return;
    // A product file with nothing new may still have images to finish.
    if (writable.length === 0 && plannable.kind !== "products") return;
    const controller = new AbortController();
    runAbort.current = controller;
    setRun({ ...IDLE_RUN, status: "running", total: writable.length });
    const send = sender(plannable, false, runId.current) as (batch: unknown[]) => Promise<BatchResponse<ItemResult>>;
    let results: ItemResult[] = [];
    try {
      const outcome = await runInBatches(writable as unknown[], {
        send,
        size: BATCH_SIZE[plannable.kind],
        signal: controller.signal,
        onProgress: ({ done, total, results: partial }) => setRun((current) => ({ ...current, done, total, results: [...partial] })),
      });
      results = outcome.results;
      if (!outcome.completed) {
        setRun((current) => ({ ...current, status: "done", results, stopped: true, stopping: false }));
        return;
      }
      if (plannable.kind === "products" && plannable.mode !== "price") {
        // Images of every product the file names that is now in the store.
        const productIds = new Map<string, string>();
        for (const result of [...preview.results, ...results]) {
          if (result.productId && result.status !== "failed") productIds.set(result.ref, result.productId);
        }
        const jobs = plannable.items.flatMap((item) => {
          const productId = productIds.get(item.ref);
          return productId && item.images.length > 0 ? [{ productId, images: productImageJobs(item) }] : [];
        });
        if (jobs.length > 0) await attachImages(jobs, controller.signal);
      }
      setRun((current) => ({ ...current, status: "done", results, stopped: controller.signal.aborted, stopping: false }));
    } catch (error) {
      setRun((current) => ({ ...current, status: "done", results: current.results, error: errorMessage(error), stopping: false }));
    }
  }, [plannable, writable, preview.results, attachImages]);

  const stop = useCallback(() => {
    runAbort.current?.abort();
    setRun((current) => ({ ...current, stopping: true }));
  }, []);

  const retryImages = useCallback(async () => {
    if (!plannable || plannable.kind !== "products") return;
    const failedUrls = new Set(run.imageFailures.map((failure) => failure.url));
    const productIds = new Map<string, string>();
    for (const result of [...preview.results, ...run.results]) if (result.productId) productIds.set(result.ref, result.productId);
    const jobs = plannable.items.flatMap((item) => {
      const productId = productIds.get(item.ref);
      const images = productImageJobs(item).filter((image) => failedUrls.has(image.url));
      return productId && images.length > 0 ? [{ productId, images }] : [];
    });
    const controller = new AbortController();
    runAbort.current = controller;
    setRun((current) => ({ ...current, status: "running", imageFailures: [] }));
    const before = run.imageAttached;
    const outcome = await attachImages(jobs, controller.signal);
    setRun((current) => ({ ...current, status: "done", imageAttached: before + outcome.attached, imageFailures: outcome.failures }));
  }, [plannable, preview.results, run.results, run.imageFailures, run.imageAttached, attachImages]);

  const counts = useMemo<ImportCounts>(() => {
    const value = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
    for (const result of run.results) {
      if (result.status === "created") value.created += 1;
      else if (result.status === "updated") value.updated += 1;
      else if (result.status === "unchanged") value.unchanged += 1;
      else if (result.status === "skipped") value.skipped += 1;
      else if (result.status === "failed") value.failed += 1;
    }
    // The dry run already showed these as in the store or not importable.
    value.skipped += stats.skip;
    value.failed += stats.failed;
    return value;
  }, [run.results, stats]);

  const downloadReport = useCallback(() => {
    saveCsv(buildImportIssuesCsv(issues), "import-report.csv");
  }, [issues]);

  const downloadFailedRows = useCallback(() => {
    if (fileState.status !== "ready") return;
    saveCsv(buildFailedRowsCsv(fileState.file.table.headers, fileState.file.table.rows, issues), "import-rows-to-fix.csv");
  }, [fileState, issues]);

  const setOption = useCallback(<K extends keyof typeof options>(key: K, value: (typeof options)[K]) => {
    setOptions((current) => ({ ...current, [key]: value }));
  }, []);

  return {
    fileState,
    readFile,
    reset,
    options,
    setOption,
    plan,
    preview,
    stats,
    issues,
    writable,
    imageCount,
    fractionalPrices,
    run,
    start,
    stop,
    retryImages,
    counts,
    downloadReport,
    downloadFailedRows,
  };
}
