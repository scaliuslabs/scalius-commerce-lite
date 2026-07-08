export const ADMIN_ASSISTANT_PAGE_STATE_EVENT =
  "scalius:admin-assistant-page-state";
export const ADMIN_ASSISTANT_PAGE_STATE_GLOBAL =
  "__SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__";
export const ADMIN_ASSISTANT_PAGE_STATE_VERSION = 1;

const MAX_TEXT_LENGTH = 160;
const MAX_ROUTE_PATH_LENGTH = 240;
const MAX_SURFACE_ID_LENGTH = 80;
const MAX_SURFACE_COUNT = 20;
const MAX_COUNT = 10_000;
const MAX_SCROLL_METRIC = 1_000_000;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BANGLADESH_PHONE_PATTERN = /(^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/g;
const BROAD_PHONE_PATTERN = /(^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const TOKEN_PREFIX_PATTERN = /\b(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}\b/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;

export type AdminAssistantSurfaceKind =
  | "dialog"
  | "form"
  | "panel"
  | "surface"
  | "table";

export interface AdminAssistantSurfaceRegistration {
  id: string;
  kind: AdminAssistantSurfaceKind;
  label?: string | null;
  visible?: boolean;
  dirty?: boolean;
  submitting?: boolean;
  open?: boolean;
  selectedCount?: number | null;
  rowCount?: number | null;
  validationErrorCount?: number | null;
  assistantActions?: AdminAssistantSurfaceActionRegistration[];
}

export type AdminAssistantSurfaceActionType =
  | "focus_surface"
  | "apply_field_draft"
  | "save_registered_form"
  | "select_visible_rows"
  | "clear_selection";

export interface AdminAssistantSurfaceActionRegistration {
  id: string;
  type: AdminAssistantSurfaceActionType;
  label?: string | null;
  safeFields?: string[];
}

export interface AdminAssistantSurfaceSnapshot {
  id: string;
  kind: AdminAssistantSurfaceKind;
  label?: string;
  dirty?: boolean;
  submitting?: boolean;
  open?: boolean;
  selectedCount?: number;
  rowCount?: number;
  validationErrorCount?: number;
  assistantActions?: AdminAssistantSurfaceActionSnapshot[];
}

export interface AdminAssistantSurfaceActionSnapshot {
  id: string;
  type: AdminAssistantSurfaceActionType;
  label?: string;
  safeFields?: string[];
}

export interface AdminAssistantSurfaceHandle {
  update: (surface: Partial<AdminAssistantSurfaceRegistration>) => void;
  unregister: () => void;
}

export interface AdminAssistantScrollState {
  top: number;
  maxTop: number;
  viewportHeight: number;
  contentHeight: number;
  atTop: boolean;
  atBottom: boolean;
}

export interface AdminAssistantPageStateSnapshot {
  version: typeof ADMIN_ASSISTANT_PAGE_STATE_VERSION;
  routePath: string;
  pageTitle: string | null;
  pageHeading: string | null;
  mainScroll: AdminAssistantScrollState;
  surfaces: AdminAssistantSurfaceSnapshot[];
}

export interface AdminAssistantPageStateInput {
  routePath: string;
  pageTitle?: string | null;
  pageHeading?: string | null;
  scrollElement?: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop"> | null;
}

type RegistryEntry = {
  token: symbol;
  surface: AdminAssistantSurfaceRegistration;
};

type RegistryListener = () => void;

declare global {
  interface Window {
    __SCALIUS_ADMIN_ASSISTANT_PAGE_STATE__?: AdminAssistantPageStateSnapshot;
  }
}

const surfaceRegistry = new Map<string, RegistryEntry>();
const registryListeners = new Set<RegistryListener>();

export function sanitizeAdminAssistantText(
  value: unknown,
  maxLength = MAX_TEXT_LENGTH,
): string | null {
  if (typeof value !== "string") return null;

  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;

  const redacted = collapsed
    .replace(BEARER_PATTERN, "Bearer [redacted-token]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(BANGLADESH_PHONE_PATTERN, "$1[redacted-phone]")
    .replace(BROAD_PHONE_PATTERN, "$1[redacted-number]")
    .replace(TOKEN_PREFIX_PATTERN, "[redacted-token]")
    .replace(LONG_TOKEN_PATTERN, "[redacted-token]");

  return boundText(redacted, maxLength);
}

export function registerAdminAssistantSurface(
  surface: AdminAssistantSurfaceRegistration,
): AdminAssistantSurfaceHandle {
  const id = sanitizeSurfaceId(surface.id);
  if (!id) {
    return {
      update: () => undefined,
      unregister: () => undefined,
    };
  }

  const token = Symbol(id);
  surfaceRegistry.set(id, { token, surface: { ...surface, id } });
  notifyRegistryListeners();

  return {
    update: (nextSurface) => {
      const entry = surfaceRegistry.get(id);
      if (entry?.token !== token) return;

      surfaceRegistry.set(id, {
        token,
        surface: { ...entry.surface, ...nextSurface, id },
      });
      notifyRegistryListeners();
    },
    unregister: () => {
      const entry = surfaceRegistry.get(id);
      if (entry?.token !== token) return;

      surfaceRegistry.delete(id);
      notifyRegistryListeners();
    },
  };
}

export function subscribeAdminAssistantSurfaceRegistry(
  listener: RegistryListener,
): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

export function createAdminAssistantPageStateSnapshot(
  input: AdminAssistantPageStateInput,
): AdminAssistantPageStateSnapshot {
  return {
    version: ADMIN_ASSISTANT_PAGE_STATE_VERSION,
    routePath: sanitizeRoutePath(input.routePath),
    pageTitle: sanitizeAdminAssistantText(input.pageTitle) ?? null,
    pageHeading: sanitizeAdminAssistantText(input.pageHeading) ?? null,
    mainScroll: createScrollState(input.scrollElement),
    surfaces: createSurfaceSnapshots(),
  };
}

export function publishAdminAssistantPageState(
  snapshot: AdminAssistantPageStateSnapshot,
): void {
  if (typeof window === "undefined") return;

  window[ADMIN_ASSISTANT_PAGE_STATE_GLOBAL] = snapshot;
  window.dispatchEvent(
    new CustomEvent(ADMIN_ASSISTANT_PAGE_STATE_EVENT, {
      detail: snapshot,
    }),
  );
}

export function clearAdminAssistantPageState(): void {
  if (typeof window === "undefined") return;

  delete window[ADMIN_ASSISTANT_PAGE_STATE_GLOBAL];
}

export function resetAdminAssistantPageStateForTest(): void {
  surfaceRegistry.clear();
  registryListeners.clear();
  clearAdminAssistantPageState();
}

function createSurfaceSnapshots(): AdminAssistantSurfaceSnapshot[] {
  const snapshots: AdminAssistantSurfaceSnapshot[] = [];

  for (const { surface } of surfaceRegistry.values()) {
    if (surface.visible === false) continue;

    const snapshot = sanitizeSurface(surface);
    if (!snapshot) continue;

    snapshots.push(snapshot);
    if (snapshots.length >= MAX_SURFACE_COUNT) break;
  }

  return snapshots;
}

function sanitizeSurface(
  surface: AdminAssistantSurfaceRegistration,
): AdminAssistantSurfaceSnapshot | null {
  const id = sanitizeSurfaceId(surface.id);
  if (!id) return null;

  const snapshot: AdminAssistantSurfaceSnapshot = {
    id,
    kind: surface.kind,
  };
  const label = sanitizeAdminAssistantText(surface.label);
  if (label) snapshot.label = label;
  if (typeof surface.dirty === "boolean") snapshot.dirty = surface.dirty;
  if (typeof surface.submitting === "boolean") {
    snapshot.submitting = surface.submitting;
  }
  if (typeof surface.open === "boolean") snapshot.open = surface.open;

  const selectedCount = boundCount(surface.selectedCount);
  if (selectedCount !== null) snapshot.selectedCount = selectedCount;
  const rowCount = boundCount(surface.rowCount);
  if (rowCount !== null) snapshot.rowCount = rowCount;
  const validationErrorCount = boundCount(surface.validationErrorCount);
  if (validationErrorCount !== null) {
    snapshot.validationErrorCount = validationErrorCount;
  }

  const actions = sanitizeSurfaceActions(surface.assistantActions);
  if (actions.length > 0) snapshot.assistantActions = actions;

  return snapshot;
}

function sanitizeSurfaceId(value: unknown): string | null {
  return sanitizeAdminAssistantText(value, MAX_SURFACE_ID_LENGTH);
}

function sanitizeSurfaceActions(
  actions: AdminAssistantSurfaceRegistration["assistantActions"],
): AdminAssistantSurfaceActionSnapshot[] {
  if (!Array.isArray(actions)) return [];

  const snapshots: AdminAssistantSurfaceActionSnapshot[] = [];
  for (const action of actions.slice(0, 10)) {
    const id = sanitizeAdminAssistantText(action.id, MAX_SURFACE_ID_LENGTH);
    if (!id || !isSurfaceActionType(action.type)) continue;

    const snapshot: AdminAssistantSurfaceActionSnapshot = {
      id,
      type: action.type,
    };
    const label = sanitizeAdminAssistantText(action.label);
    if (label) snapshot.label = label;

    const safeFields = sanitizeSafeFieldList(action.safeFields);
    if (safeFields.length > 0) snapshot.safeFields = safeFields;

    snapshots.push(snapshot);
  }

  return snapshots;
}

function sanitizeSafeFieldList(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];

  const safeFields: string[] = [];
  for (const field of fields.slice(0, 12)) {
    const sanitized = sanitizeAdminAssistantText(field, 48);
    if (!sanitized || safeFields.includes(sanitized)) continue;
    safeFields.push(sanitized);
  }
  return safeFields;
}

function isSurfaceActionType(
  value: unknown,
): value is AdminAssistantSurfaceActionType {
  return (
    value === "focus_surface" ||
    value === "apply_field_draft" ||
    value === "save_registered_form" ||
    value === "select_visible_rows" ||
    value === "clear_selection"
  );
}

function sanitizeRoutePath(value: unknown): string {
  const rawPath = typeof value === "string" ? value : "";
  const pathOnly = rawPath.split("?")[0]?.split("#")[0] ?? "";
  const sanitized = sanitizeAdminAssistantText(pathOnly, MAX_ROUTE_PATH_LENGTH);

  if (!sanitized?.startsWith("/admin")) return "/admin";
  return sanitized;
}

function createScrollState(
  element: AdminAssistantPageStateInput["scrollElement"],
): AdminAssistantScrollState {
  const top = boundScrollMetric(element?.scrollTop);
  const viewportHeight = boundScrollMetric(element?.clientHeight);
  const contentHeight = boundScrollMetric(element?.scrollHeight);
  const maxTop = Math.max(0, contentHeight - viewportHeight);

  return {
    top: Math.min(top, maxTop),
    maxTop,
    viewportHeight,
    contentHeight,
    atTop: top <= 0,
    atBottom: maxTop <= 0 || top >= maxTop - 1,
  };
}

function boundCount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_COUNT, Math.max(0, Math.round(value)));
}

function boundScrollMetric(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_SCROLL_METRIC, Math.max(0, Math.round(value)));
}

function boundText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function notifyRegistryListeners(): void {
  for (const listener of registryListeners) {
    listener();
  }
}
