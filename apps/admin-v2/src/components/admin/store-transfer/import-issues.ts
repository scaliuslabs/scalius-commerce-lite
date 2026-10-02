// The preview's and the report's list of problems: the mapper's row issues
// plus what the server refused, each pinned to a line of the uploaded file.
import type { ImportIssue } from "@scalius/shared/store-transfer/issues";
import type { ProductImportItem } from "@scalius/shared/store-transfer/products";
import type { CustomerImportItem } from "@scalius/shared/store-transfer/customers";
import type { InventoryImportItem } from "@scalius/shared/store-transfer/inventory";
import type { ImportPlan } from "./import-plan";
import { issueLine } from "./import-plan";

export interface ServerIssue {
  code: string;
  message: string;
  variantIndex?: number;
  field?: string;
}

export interface ServerResult {
  ref: string;
  status: string;
  issues: ServerIssue[];
}

const FAILED = new Set(["failed"]);

type PlannedPlan = Exclude<ImportPlan, { kind: "unknown" | "mismatch" }>;

/** Server issues of `results` as file issues (errors for failed rows, warnings otherwise). */
export function serverIssues(plan: PlannedPlan, results: readonly ServerResult[]): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const byRef = new Map<string, ProductImportItem | CustomerImportItem | InventoryImportItem>(
    (plan.items as ReadonlyArray<ProductImportItem | CustomerImportItem | InventoryImportItem>).map((item) => [item.ref, item]),
  );
  for (const result of results) {
    const item = byRef.get(result.ref);
    for (const issue of result.issues) {
      // "Already in the store" is the expected outcome of a re-run, not a problem.
      if (issue.code === "already_exists") continue;
      let line: number | null = null;
      if (item && plan.kind === "products") line = issueLine(plan, item as ProductImportItem, issue.variantIndex);
      else if (item && "line" in item) line = item.line ?? null;
      issues.push({
        severity: FAILED.has(result.status) ? "error" : "warning",
        code: issue.code,
        message: issue.message,
        line,
        subject: result.ref,
        column: issue.field ?? null,
      });
    }
  }
  return issues;
}

/** Every issue, file order first. */
export function mergeIssues(...lists: ReadonlyArray<readonly ImportIssue[]>): ImportIssue[] {
  return lists.flat().sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
}
