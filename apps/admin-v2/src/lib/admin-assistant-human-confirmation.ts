export const ADMIN_ASSISTANT_HUMAN_ACTIONS = {
  generateImage: "admin.media.image.generate",
  saveGeneratedImage: "admin.media.image.save",
} as const;

export type AdminAssistantHumanActionBaseId =
  (typeof ADMIN_ASSISTANT_HUMAN_ACTIONS)[keyof typeof ADMIN_ASSISTANT_HUMAN_ACTIONS];
export const ADMIN_ASSISTANT_HUMAN_ACTION_SCOPES = [
  "library-page",
  "media-picker",
] as const;
export type AdminAssistantHumanActionScope =
  (typeof ADMIN_ASSISTANT_HUMAN_ACTION_SCOPES)[number];
export type AdminAssistantHumanActionId =
  `${AdminAssistantHumanActionBaseId}.${AdminAssistantHumanActionScope}.${string}`;
export type AdminAssistantHumanActionOutcome =
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AdminAssistantHumanActionOperation {
  actionId: AdminAssistantHumanActionId;
  operationId: string;
}

export type AdminAssistantHumanActionEvent =
  | (AdminAssistantHumanActionOperation & { phase: "started" })
  | (AdminAssistantHumanActionOperation & {
      phase: "finished";
      outcome: AdminAssistantHumanActionOutcome;
    })
  | { actionId: AdminAssistantHumanActionId; phase: "cancelled" };

type ConfirmationListener = (
  event: Readonly<AdminAssistantHumanActionEvent>,
) => void;

// Intentionally module-private: computer programs cannot dispatch a DOM event
// to forge a click or completion. A one-use operation token binds each async
// outcome to the exact component instance and human click that started it.
const listeners = new Set<ConfirmationListener>();
const activeOperations = new Map<string, AdminAssistantHumanActionId>();

export function adminAssistantHumanActionId(
  baseId: AdminAssistantHumanActionBaseId,
  scope: AdminAssistantHumanActionScope,
  instanceId: string,
): AdminAssistantHumanActionId {
  const normalizedInstance = instanceId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(normalizedInstance)) {
    throw new Error("Admin human-action instance ID is invalid");
  }
  return `${baseId}.${scope}.${normalizedInstance}`;
}

export function createAdminAssistantHumanActionInstanceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `p${Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function claimAdminAssistantHumanAction(
  actionId: AdminAssistantHumanActionId,
  activation: Event,
): AdminAssistantHumanActionOperation | null {
  if (!isAdminAssistantHumanActionId(actionId)) {
    throw new Error("Admin human action ID is invalid");
  }
  if (activation.type !== "click" || !activation.isTrusted) return null;
  const operation = Object.freeze({
    actionId,
    operationId: createOperationId(),
  });
  activeOperations.set(operation.operationId, actionId);
  publish({ ...operation, phase: "started" });
  return operation;
}

export function finishAdminAssistantHumanAction(
  operation: AdminAssistantHumanActionOperation,
  outcome: AdminAssistantHumanActionOutcome,
): void {
  if (
    activeOperations.get(operation.operationId) !== operation.actionId ||
    !isAdminAssistantHumanActionId(operation.actionId) ||
    !isOperationId(operation.operationId) ||
    !isOutcome(outcome)
  ) return;
  activeOperations.delete(operation.operationId);
  publish({ ...operation, phase: "finished", outcome });
}

export function cancelAdminAssistantHumanAction(
  actionId: AdminAssistantHumanActionId,
): void {
  if (!isAdminAssistantHumanActionId(actionId)) {
    throw new Error("Admin human action ID is invalid");
  }
  publish({ actionId, phase: "cancelled" });
}

/** Cancels every in-flight human-confirmed browser operation before Stop. */
export function cancelAllAdminAssistantHumanActions(): void {
  const operations = [...activeOperations.entries()];
  activeOperations.clear();
  for (const [operationId, actionId] of operations) {
    publish({ actionId, operationId, phase: "finished", outcome: "cancelled" });
  }
}

export function subscribeAdminAssistantHumanConfirmation(
  listener: ConfirmationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(event: AdminAssistantHumanActionEvent): void {
  const safeEvent = Object.freeze({ ...event });
  for (const listener of listeners) listener(safeEvent);
}

function createOperationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const token = Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `aho_${token}`;
}

function isAdminAssistantHumanActionId(value: unknown): value is AdminAssistantHumanActionId {
  return typeof value === "string" &&
    /^(?:admin\.media\.image\.(?:generate|save))\.(?:library-page|media-picker)\.[a-z0-9][a-z0-9-]{0,31}$/u
      .test(value);
}

function isOperationId(value: unknown): value is string {
  return typeof value === "string" && /^aho_[a-f0-9]{24}$/u.test(value);
}

function isOutcome(value: unknown): value is AdminAssistantHumanActionOutcome {
  return value === "succeeded" || value === "failed" || value === "cancelled";
}
