import { sanitizeAdminAssistantText } from "./page-state";

const MAX_ACTION_ID_LENGTH = 80;
const MAX_ACTION_LABEL_LENGTH = 160;
const MAX_ACTION_FIELD_LENGTH = 80;
const MAX_ACTION_VALUE_LENGTH = 12_000;
const MAX_ACTION_ROW_IDS = 100;
const MAX_ACTION_ROW_ID_LENGTH = 80;

export type AdminAssistantPageActionType =
  | "focus_surface"
  | "apply_field_draft"
  | "save_registered_form"
  | "select_visible_rows"
  | "clear_selection";

type AdminAssistantPageActionValue = string | number | boolean | null;

interface AdminAssistantBasePageAction {
  id: string;
  type: AdminAssistantPageActionType;
  targetId: string;
  label?: string;
}

export interface AdminAssistantFocusSurfaceAction
  extends AdminAssistantBasePageAction {
  type: "focus_surface";
  fieldName?: string;
}

export interface AdminAssistantApplyFieldDraftAction
  extends AdminAssistantBasePageAction {
  type: "apply_field_draft";
  fieldName: string;
  value: AdminAssistantPageActionValue;
}

export interface AdminAssistantSaveRegisteredFormAction
  extends AdminAssistantBasePageAction {
  type: "save_registered_form";
}

export interface AdminAssistantSelectVisibleRowsAction
  extends AdminAssistantBasePageAction {
  type: "select_visible_rows";
  rowIds: string[];
}

export interface AdminAssistantClearSelectionAction
  extends AdminAssistantBasePageAction {
  type: "clear_selection";
}

export type AdminAssistantPageAction =
  | AdminAssistantFocusSurfaceAction
  | AdminAssistantApplyFieldDraftAction
  | AdminAssistantSaveRegisteredFormAction
  | AdminAssistantSelectVisibleRowsAction
  | AdminAssistantClearSelectionAction;

export interface AdminAssistantPageActionHandlerHandle {
  unregister: () => void;
}

export type AdminAssistantPageActionHandler = (
  action: AdminAssistantPageAction,
) => boolean | Promise<boolean>;

type ActionHandlerEntry = {
  token: symbol;
  handler: AdminAssistantPageActionHandler;
};

const pageActionHandlers = new Map<string, ActionHandlerEntry>();

export function registerAdminAssistantPageActionHandler(
  id: string,
  handler: AdminAssistantPageActionHandler,
): AdminAssistantPageActionHandlerHandle {
  const actionId = sanitizeActionId(id);
  if (!actionId || typeof handler !== "function") {
    return { unregister: () => undefined };
  }

  const token = Symbol(actionId);
  pageActionHandlers.set(actionId, { token, handler });

  return {
    unregister: () => {
      const entry = pageActionHandlers.get(actionId);
      if (entry?.token !== token) return;

      pageActionHandlers.delete(actionId);
    },
  };
}

export async function executeAdminAssistantPageAction(
  action: unknown,
): Promise<boolean> {
  const sanitizedAction = sanitizePageAction(action);
  if (!sanitizedAction) return false;

  const entry = pageActionHandlers.get(sanitizedAction.id);
  if (!entry) return false;

  try {
    return (await entry.handler(sanitizedAction)) === true;
  } catch {
    return false;
  }
}

export function resetAdminAssistantPageActionsForTest(): void {
  pageActionHandlers.clear();
}

function sanitizePageAction(action: unknown): AdminAssistantPageAction | null {
  if (!action || typeof action !== "object") return null;

  const record = action as Record<string, unknown>;
  const id = sanitizeActionId(record.id);
  const type = sanitizeActionType(record.type);
  const targetId = sanitizeTargetId(record.targetId);
  if (!id || !type || !targetId) return null;

  const base = {
    id,
    type,
    targetId,
    label: sanitizeActionLabel(record.label) ?? undefined,
  };

  if (type === "focus_surface") {
    return {
      ...base,
      type,
      fieldName: sanitizeFieldName(record.fieldName) ?? undefined,
    };
  }

  if (type === "apply_field_draft") {
    const fieldName = sanitizeFieldName(record.fieldName);
    if (!fieldName) return null;

    return {
      ...base,
      type,
      fieldName,
      value: sanitizeActionValue(record.value),
    };
  }

  if (type === "select_visible_rows") {
    return {
      ...base,
      type,
      rowIds: sanitizeRowIds(record.rowIds),
    };
  }

  return { ...base, type };
}

function sanitizeActionType(
  value: unknown,
): AdminAssistantPageActionType | null {
  if (
    value === "focus_surface" ||
    value === "apply_field_draft" ||
    value === "save_registered_form" ||
    value === "select_visible_rows" ||
    value === "clear_selection"
  ) {
    return value;
  }

  return null;
}

function sanitizeActionId(value: unknown): string | null {
  return sanitizeAdminAssistantText(value, MAX_ACTION_ID_LENGTH);
}

function sanitizeTargetId(value: unknown): string | null {
  return sanitizeAdminAssistantText(value, MAX_ACTION_ID_LENGTH);
}

function sanitizeFieldName(value: unknown): string | null {
  return sanitizeAdminAssistantText(value, MAX_ACTION_FIELD_LENGTH);
}

function sanitizeActionLabel(value: unknown): string | null {
  return sanitizeAdminAssistantText(value, MAX_ACTION_LABEL_LENGTH);
}

function sanitizeActionValue(value: unknown): AdminAssistantPageActionValue {
  if (typeof value === "string") {
    return sanitizeAdminAssistantText(value, MAX_ACTION_VALUE_LENGTH) ?? "";
  }
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  return null;
}

function sanitizeRowIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const rowIds: string[] = [];
  for (const rowId of value) {
    const sanitized = sanitizeAdminAssistantText(rowId, MAX_ACTION_ROW_ID_LENGTH);
    if (!sanitized) continue;

    rowIds.push(sanitized);
    if (rowIds.length >= MAX_ACTION_ROW_IDS) break;
  }

  return rowIds;
}
