import {
  sanitizeAdminAssistantText,
  type AdminAssistantSurfaceActionRegistration,
  type AdminAssistantSurfaceRegistration,
} from "../assistant/page-state";

export const PRODUCT_ASSISTANT_SAFE_FIELDS = [
  "name",
  "description",
] as const;

const PRODUCT_ASSISTANT_ACTION_NAMES = [
  "focus_surface",
  "apply_field_draft",
  "save_registered_form",
] as const;
const MAX_PRODUCT_ASSISTANT_DRAFT_LENGTH = 20_000;
const MAX_PRODUCT_ASSISTANT_RESOURCE_ID_LENGTH = 28;
const MAX_PRODUCT_ASSISTANT_INSTANCE_ID_LENGTH = 10;

let productAssistantSurfaceSequence = 0;

export type ProductAssistantField =
  (typeof PRODUCT_ASSISTANT_SAFE_FIELDS)[number];
export type ProductAssistantActionName =
  (typeof PRODUCT_ASSISTANT_ACTION_NAMES)[number];

export interface ProductAssistantSurfaceDraft {
  mode: "create" | "edit";
  name?: unknown;
  description?: unknown;
}

export interface ProductAssistantSurfaceIdentity {
  mode: "create" | "edit";
  productId?: string | null;
  instanceId: string;
}

export interface ProductAssistantActionResult {
  ok: boolean;
  action: ProductAssistantActionName;
  field?: ProductAssistantField;
  reason?:
    | "already_submitting"
    | "focus_unavailable"
    | "invalid_value"
    | "missing_field"
    | "too_large"
    | "unsupported_field"
    | "validation_errors";
}

export interface ProductAssistantActionController {
  focusField: (field: ProductAssistantField) => boolean | Promise<boolean>;
  applyFieldDraft: (
    field: ProductAssistantField,
    value: string,
  ) => void | Promise<void>;
  saveForm: () => boolean | Promise<boolean>;
  isSubmitting?: () => boolean;
  validateForm?: () => boolean | Promise<boolean>;
  getValidationErrorCount?: () => number;
}

export type ProductAssistantActionHandlers = {
  [ActionName in ProductAssistantActionName]: (
    input?: unknown,
  ) => Promise<ProductAssistantActionResult>;
};

export interface ProductAssistantSurfaceCapabilities {
  actions: ProductAssistantActionName[];
  safeFields: ProductAssistantField[];
}

export interface ProductAssistantSurfaceRegistration
  extends AdminAssistantSurfaceRegistration {
  assistantCapabilities: ProductAssistantSurfaceCapabilities;
  assistantActions: AdminAssistantSurfaceActionRegistration[];
}

export const PRODUCT_ASSISTANT_SURFACE_CAPABILITIES: ProductAssistantSurfaceCapabilities =
  {
    actions: [...PRODUCT_ASSISTANT_ACTION_NAMES],
    safeFields: [...PRODUCT_ASSISTANT_SAFE_FIELDS],
  };

export function createProductAssistantSurfaceInstanceId(): string {
  const randomId = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  if (randomId) return randomId.slice(0, MAX_PRODUCT_ASSISTANT_INSTANCE_ID_LENGTH);

  productAssistantSurfaceSequence += 1;
  return `${Date.now().toString(36)}${productAssistantSurfaceSequence.toString(36)}`
    .slice(-MAX_PRODUCT_ASSISTANT_INSTANCE_ID_LENGTH);
}

export function getProductAssistantSurfaceId({
  mode,
  productId,
  instanceId,
}: ProductAssistantSurfaceIdentity): string {
  const resourceId = mode === "edit"
    ? sanitizeAdminAssistantText(
        productId,
        MAX_PRODUCT_ASSISTANT_RESOURCE_ID_LENGTH,
      ) ?? "unresolved"
    : "new";
  const safeInstanceId =
    sanitizeAdminAssistantText(
      instanceId,
      MAX_PRODUCT_ASSISTANT_INSTANCE_ID_LENGTH,
    ) ?? "instance";

  return `product-${mode}:${resourceId}:${safeInstanceId}`;
}

export function createProductAssistantSurfaceActions(
  surfaceId: string,
): AdminAssistantSurfaceActionRegistration[] {
  return [
    {
      id: getProductAssistantActionId(surfaceId, "focus_surface"),
      type: "focus_surface",
      label: "Focus product field",
      safeFields: [...PRODUCT_ASSISTANT_SAFE_FIELDS],
    },
    {
      id: getProductAssistantActionId(surfaceId, "apply_field_draft"),
      type: "apply_field_draft",
      label: "Apply product draft",
      safeFields: [...PRODUCT_ASSISTANT_SAFE_FIELDS],
    },
    {
      id: getProductAssistantActionId(surfaceId, "save_registered_form"),
      type: "save_registered_form",
      label: "Save product form",
    },
  ];
}

export function getProductAssistantActionId(
  surfaceId: string,
  action: ProductAssistantActionName,
): string {
  return `${surfaceId}:${action}`;
}

export function buildProductAssistantSurfaceLabel(
  draft: ProductAssistantSurfaceDraft,
): string {
  const modeLabel = draft.mode === "edit" ? "Edit product" : "Create product";
  const nameState = hasAssistantFieldValue(draft.name) ? "populated" : "empty";
  const descriptionState = hasAssistantFieldValue(draft.description)
    ? "populated"
    : "empty";

  const parts = [
    modeLabel,
    "safe fields: name, description",
    `name: ${nameState}`,
    `description: ${descriptionState}`,
    "actions: focus, draft, save",
  ];

  return sanitizeAdminAssistantText(parts.join(" | ")) ?? modeLabel;
}

export function createProductAssistantActionHandlers(
  controller: ProductAssistantActionController,
): ProductAssistantActionHandlers {
  return {
    focus_surface: async (input) => {
      const fieldResult = readAssistantField(input, "name");
      if (fieldResult.reason) {
        return actionRejected("focus_surface", fieldResult.reason);
      }

      const focused = await controller.focusField(fieldResult.field);
      if (!focused) {
        return actionRejected(
          "focus_surface",
          "focus_unavailable",
          fieldResult.field,
        );
      }

      return actionAccepted("focus_surface", fieldResult.field);
    },
    apply_field_draft: async (input) => {
      const fieldResult = readAssistantField(input);
      if (fieldResult.reason) {
        return actionRejected("apply_field_draft", fieldResult.reason);
      }

      const valueResult = readAssistantDraftValue(input);
      if (valueResult.reason) {
        return actionRejected(
          "apply_field_draft",
          valueResult.reason,
          fieldResult.field,
        );
      }

      await controller.applyFieldDraft(fieldResult.field, valueResult.value);
      return actionAccepted("apply_field_draft", fieldResult.field);
    },
    save_registered_form: async () => {
      if (controller.isSubmitting?.()) {
        return actionRejected("save_registered_form", "already_submitting");
      }

      const validationOk = await controller.validateForm?.();
      if (
        validationOk === false ||
        (validationOk === undefined &&
          (controller.getValidationErrorCount?.() ?? 0) > 0)
      ) {
        return actionRejected("save_registered_form", "validation_errors");
      }

      const saved = await controller.saveForm();
      if (!saved) {
        return actionRejected("save_registered_form", "validation_errors");
      }

      return actionAccepted("save_registered_form");
    },
  };
}

export function focusProductAssistantFieldInForm(
  root: ParentNode | null,
  field: ProductAssistantField,
): boolean {
  if (!root) return false;

  if (field === "name") {
    const nameInput = root.querySelector<HTMLInputElement>(
      'input[name="name"]:not([type="hidden"])',
    );
    if (!isFocusableElement(nameInput)) return false;
    nameInput.focus();
    nameInput.scrollIntoView?.({ block: "center", behavior: "smooth" });
    return true;
  }

  activateDescriptionTab(root);
  const editor = findDescriptionEditor(root);
  if (!isFocusableElement(editor)) return false;

  editor.focus();
  editor.scrollIntoView?.({ block: "center", behavior: "smooth" });
  queueMicrotask(() => {
    const mountedEditor = findDescriptionEditor(root);
    if (isFocusableElement(mountedEditor)) {
      mountedEditor.focus();
    }
  });
  return true;
}

export function countProductAssistantValidationErrors(value: unknown): number {
  if (!value || typeof value !== "object") return 0;

  let count = 0;
  for (const entry of Object.values(value)) {
    if (!entry) continue;
    if (Array.isArray(entry)) {
      count += entry.reduce(
        (total, item) => total + countProductAssistantValidationErrors(item),
        0,
      );
      continue;
    }
    if (typeof entry !== "object") continue;

    const record = entry as Record<string, unknown>;
    if (typeof record.message === "string" || typeof record.type === "string") {
      count += 1;
      continue;
    }
    count += countProductAssistantValidationErrors(record);
  }

  return count;
}

function hasAssistantFieldValue(value: unknown): boolean {
  if (typeof value !== "string") return false;

  const withoutScripts = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]*>/g, " ");
  const decoded = decodeCommonHtmlEntities(withoutTags).replace(
    /\s+([.,!?;:])/g,
    "$1",
  );

  return decoded.trim().length > 0;
}

function readAssistantField(
  input: unknown,
  defaultField?: ProductAssistantField,
):
  | { field: ProductAssistantField; reason?: never }
  | { field?: never; reason: "missing_field" | "unsupported_field" } {
  const value =
    readObjectString(input, "fieldName") ??
    readObjectString(input, "field") ??
    readNestedObjectString(input, "focus", "field") ??
    defaultField;
  if (!value) return { reason: "missing_field" };
  if (!isProductAssistantField(value)) {
    return { reason: "unsupported_field" };
  }

  return { field: value };
}

function readAssistantDraftValue(input: unknown):
  | { value: string; reason?: never }
  | { value?: never; reason: "invalid_value" | "too_large" } {
  const value =
    readObjectString(input, "value") ??
    readObjectString(input, "draft") ??
    readObjectString(input, "text");

  if (typeof value !== "string") {
    return { reason: "invalid_value" };
  }
  if (value.length > MAX_PRODUCT_ASSISTANT_DRAFT_LENGTH) {
    return { reason: "too_large" };
  }

  return { value };
}

function readObjectString(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readNestedObjectString(
  input: unknown,
  parentKey: string,
  childKey: string,
): string | null {
  if (!input || typeof input !== "object") return null;

  const parent = (input as Record<string, unknown>)[parentKey];
  if (!parent || typeof parent !== "object") return null;

  const value = (parent as Record<string, unknown>)[childKey];
  return typeof value === "string" ? value : null;
}

function isProductAssistantField(value: string): value is ProductAssistantField {
  return PRODUCT_ASSISTANT_SAFE_FIELDS.includes(value as ProductAssistantField);
}

function actionAccepted(
  action: ProductAssistantActionName,
  field?: ProductAssistantField,
): ProductAssistantActionResult {
  const result: ProductAssistantActionResult = {
    ok: true,
    action,
  };
  if (field) result.field = field;
  return result;
}

function actionRejected(
  action: ProductAssistantActionName,
  reason: NonNullable<ProductAssistantActionResult["reason"]>,
  field?: ProductAssistantField,
): ProductAssistantActionResult {
  const result: ProductAssistantActionResult = {
    ok: false,
    action,
    reason,
  };
  if (field) result.field = field;
  return result;
}

function activateDescriptionTab(root: ParentNode): void {
  const tabs = Array.from(
    root.querySelectorAll<HTMLElement>('[role="tab"], button'),
  );
  const descriptionTab = tabs.find(
    (element) =>
      element.textContent?.trim().toLowerCase() === "description" &&
      isFocusableElement(element),
  );

  descriptionTab?.click();
}

function findDescriptionEditor(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Rich text editor"], .ProseMirror[contenteditable="true"], .ProseMirror',
  );
}

function isFocusableElement(
  element: HTMLElement | null | undefined,
): element is HTMLElement {
  if (!element) return false;
  if (element.hidden || element.getAttribute("aria-hidden") === "true") {
    return false;
  }
  if ("disabled" in element && Boolean(element.disabled)) return false;
  return true;
}

function decodeCommonHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}
