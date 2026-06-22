import type { CartValidationIssue } from "../api/orders";

export type BulkCartRepairAction = "remove" | "reduce_quantity" | "refresh_item";

export type CartValidationIssueGroups = Record<string, CartValidationIssue[]>;

export interface BulkCartRepairActionCounts {
  remove: number;
  reduceQuantity: number;
  refreshPrice: number;
}

function canRemove(issue: CartValidationIssue): boolean {
  if (issue.action === "remove") return true;
  return issue.action === "reduce_quantity" && (
    typeof issue.availableQuantity !== "number" || issue.availableQuantity < 1
  );
}

function canReduce(issue: CartValidationIssue): boolean {
  return issue.action === "reduce_quantity" &&
    typeof issue.availableQuantity === "number" &&
    issue.availableQuantity > 0;
}

function canRefresh(issue: CartValidationIssue): boolean {
  return issue.action === "refresh_item" && typeof issue.currentPrice === "number";
}

function hasAction(issues: CartValidationIssue[], action: BulkCartRepairAction): boolean {
  if (action === "remove") return issues.some(canRemove);
  if (action === "reduce_quantity") return issues.some(canReduce);
  return issues.some(canRefresh);
}

export function getBulkCartRepairActionCounts(
  groups: CartValidationIssueGroups,
): BulkCartRepairActionCounts {
  const entries = Object.values(groups);
  return {
    remove: entries.filter((issues) => hasAction(issues, "remove")).length,
    reduceQuantity: entries.filter((issues) => hasAction(issues, "reduce_quantity")).length,
    refreshPrice: entries.filter((issues) => hasAction(issues, "refresh_item")).length,
  };
}

export function selectCartKeysForBulkRepair(
  groups: CartValidationIssueGroups,
  action: BulkCartRepairAction,
): string[] {
  return Object.entries(groups)
    .filter(([, issues]) => hasAction(issues, action))
    .map(([cartKey]) => cartKey);
}

function actionButton(label: string, count: number, handler: string): string {
  if (count <= 0) return "";
  return `<button type="button" class="rounded-md border border-current/20 px-2.5 py-1 text-xs font-semibold hover:bg-background/70" onclick="${handler}">${label} (${count})</button>`;
}

export function renderBulkCartRepairActions(
  groups: CartValidationIssueGroups,
): string {
  const counts = getBulkCartRepairActionCounts(groups);
  const actions = [
    actionButton("Remove unavailable", counts.remove, "window.bulkRemoveCartIssueItems()"),
    actionButton("Update quantities", counts.reduceQuantity, "window.bulkReduceCartIssueItems()"),
    actionButton("Refresh prices", counts.refreshPrice, "window.bulkRefreshCartIssueItems()"),
  ].filter(Boolean);

  if (actions.length === 0) return "";
  return `<div class="mt-2 flex flex-wrap gap-2">${actions.join("")}</div>`;
}
