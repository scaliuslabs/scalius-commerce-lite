import { ORDER_NOTIFICATION_TYPES, STAFF_ALERT_NOTIFICATION_TYPES } from "./notification-types";

/** Private staff bell contract. User identity always comes from authenticated context. */
export const STAFF_ALERT_SCOPES = ["orders", "conversations"] as const;
export type StaffAlertScope = (typeof STAFF_ALERT_SCOPES)[number];
export const STAFF_ALERT_COUNT_CAP = 99 as const;
export const STAFF_ALERT_PAGE_SIZE = 20;
export const STAFF_ALERT_MAX_PAGE_SIZE = 50;

export interface StaffAlertUnread {
  unreadCount: number;
  unreadCountCapped: boolean;
  countCap: typeof STAFF_ALERT_COUNT_CAP;
}
export interface StaffAlertScopeState {
  scope: StaffAlertScope;
  revision: number;
  readThrough: number;
  clearedThrough: number;
}
export interface StaffAlertSummary extends StaffAlertUnread {
  /** Last committed delivery sequence for this account, never wall-clock time. */
  head: number;
  /** Only scopes currently authorized for this account. */
  scopes: StaffAlertScopeState[];
}
export const STAFF_ALERT_KINDS = /* @__PURE__ */ (() => [
  ...ORDER_NOTIFICATION_TYPES, ...STAFF_ALERT_NOTIFICATION_TYPES, "conversation_message",
] as const)();
export type StaffAlertKind = (typeof STAFF_ALERT_KINDS)[number];

export interface StaffAlertItem {
  seq: number;
  id: string;
  scope: StaffAlertScope;
  kind: StaffAlertKind;
  subjectId: string;
  /** ISO8601 display time; ordering and cursors use seq alone. */
  occurredAt: string;
  orderNumber: string | null;
  read: boolean;
  /** Code-owned dashboard path, not stored provider/app text. */
  href: string;
}
export interface StaffAlertPage extends StaffAlertSummary {
  items: StaffAlertItem[];
  nextBefore: number | null;
}
export interface StaffAlertReadAllInput {
  through: number;
  /** Scopes rendered in the caller's view; fresh authorization is still enforced. */
  scopes: StaffAlertScope[];
}
export interface StaffAlertClearInput {
  /** Stable per-click id reused for transport retries. */
  operationId: string;
  through: number;
  /** All requested scopes must still be allowed and match their revisions. */
  scopes: Array<{ scope: StaffAlertScope; revision: number }>;
}
export interface StaffAlertUndoInput {
  operationId: string;
  scopes: Array<{ scope: StaffAlertScope; revision: number }>;
}
export interface StaffAlertMutation {
  summary: StaffAlertSummary;
  /** Only returned by Clear all; Undo is CAS-protected and may return conflict. */
  undo?: StaffAlertUndoInput;
}

// Future private HTTP routes, not added by this storage candidate:
// GET /admin/notifications?beforeSeq=&limit= ; GET /admin/notifications/summary
// POST /admin/notifications/:seq/read ; POST /admin/notifications/read-all
// POST /admin/notifications/clear-all ; POST /admin/notifications/clear-all/undo
// Clear all explicitly dismisses and marks read through the shown head.
// Clear/Undo conflict is HTTP409 with no partial scope mutation. Never label Clear read.
