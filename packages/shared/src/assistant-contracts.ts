import { z } from "zod/v4";

export const ASSISTANT_PROTOCOL_VERSION = "2026-07-10" as const;

export const ASSISTANT_SURFACES = ["admin", "storefront"] as const;
export const ASSISTANT_ACTOR_TYPES = ["admin", "customer", "guest", "system"] as const;
export const ASSISTANT_RISK_CLASSES = [
  "read_only",
  "reversible",
  "consequential",
  "high_risk",
] as const;
export const ASSISTANT_CONFIRMATION_POLICIES = [
  "none",
  "click",
  "explicit",
  "step_up",
] as const;
export const ASSISTANT_IDEMPOTENCY_POLICIES = [
  "not_applicable",
  "inherent",
  "required",
] as const;
export const ASSISTANT_WORKFLOW_STATUSES = [
  "queued",
  "running",
  "input_required",
  "approval_required",
  "retrying",
  "succeeded",
  "failed",
  "compensating",
  "cancelled",
] as const;
export const ASSISTANT_ACTION_STATUSES = [
  "prepared",
  "approval_required",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
  "superseded",
] as const;

export type AssistantSurface = (typeof ASSISTANT_SURFACES)[number];
export type AssistantActorType = (typeof ASSISTANT_ACTOR_TYPES)[number];
export type AssistantRiskClass = (typeof ASSISTANT_RISK_CLASSES)[number];
export type AssistantConfirmationPolicy = (typeof ASSISTANT_CONFIRMATION_POLICIES)[number];
export type AssistantIdempotencyPolicy = (typeof ASSISTANT_IDEMPOTENCY_POLICIES)[number];
export type AssistantWorkflowStatus = (typeof ASSISTANT_WORKFLOW_STATUSES)[number];
export type AssistantActionStatus = (typeof ASSISTANT_ACTION_STATUSES)[number];

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const opaqueId = boundedText(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const resourceReference = boundedText(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/~-]*$/);
const capabilityId = boundedText(160).regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const SENSITIVE_QUERY_NAME_PATTERN =
  /(?:auth|bearer|credential|email|jwt|key|mobile|otp|pass|password|phone|proof|receipt|recovery|secret|session|sig|signature|token)/i;
const TOKEN_LIKE_PATH_VALUE_PATTERN =
  /(?:\bBearer\s+|(?:chk|cst|otp|tok|token|session|secret|sk|pk|approval)_[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?|[A-Fa-f0-9]{32,})/i;
const EMAIL_PATH_VALUE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATH_VALUE_PATTERN = /(?:^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/;
const ENCODED_PATH_SEPARATOR_PATTERN = /%(?:2e|2f|5c)/i;

const safePath = boundedText(500).refine(isSafeAssistantPath, "Expected a safe same-origin path");

function isSafeAssistantPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\")) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return false;
  }
  if (ENCODED_PATH_SEPARATOR_PATTERN.test(value)) return false;

  let parsed: URL;
  try {
    parsed = new URL(value, "https://assistant.invalid");
  } catch {
    return false;
  }
  if (parsed.origin !== "https://assistant.invalid" || parsed.hash) return false;
  if (parsed.pathname.split("/").some((segment) => segment === "." || segment === "..")) {
    return false;
  }

  for (const [name, queryValue] of parsed.searchParams) {
    if (!name || name.length > 80 || queryValue.length > 240) return false;
    if (SENSITIVE_QUERY_NAME_PATTERN.test(name)) return false;
    if (
      TOKEN_LIKE_PATH_VALUE_PATTERN.test(queryValue) ||
      EMAIL_PATH_VALUE_PATTERN.test(queryValue) ||
      PHONE_PATH_VALUE_PATTERN.test(queryValue)
    ) {
      return false;
    }
  }
  return true;
}

export const assistantSurfaceSchema = z.enum(ASSISTANT_SURFACES);
export const assistantActorTypeSchema = z.enum(ASSISTANT_ACTOR_TYPES);
export const assistantRiskClassSchema = z.enum(ASSISTANT_RISK_CLASSES);
export const assistantConfirmationPolicySchema = z.enum(ASSISTANT_CONFIRMATION_POLICIES);
export const assistantIdempotencyPolicySchema = z.enum(ASSISTANT_IDEMPOTENCY_POLICIES);
export const assistantWorkflowStatusSchema = z.enum(ASSISTANT_WORKFLOW_STATUSES);
export const assistantActionStatusSchema = z.enum(ASSISTANT_ACTION_STATUSES);

export const assistantVersionPreconditionSchema = z.object({
  resourceType: capabilityId,
  resourceId: resourceReference,
  version: boundedText(160),
}).strict();

export const assistantCommandDescriptorSchema = z.object({
  id: capabilityId,
  title: boundedText(120),
  description: boundedText(600),
  surface: assistantSurfaceSchema,
  permission: boundedText(160).nullable(),
  riskClass: assistantRiskClassSchema,
  confirmationPolicy: assistantConfirmationPolicySchema,
  idempotencyPolicy: assistantIdempotencyPolicySchema,
  readOnly: z.boolean(),
  reversible: z.boolean(),
  destructive: z.boolean(),
  financial: z.boolean(),
  externalSideEffect: z.boolean(),
  freshAuthRequired: z.boolean(),
  supportsDryRun: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.readOnly && value.riskClass !== "read_only") {
    context.addIssue({
      code: "custom",
      path: ["riskClass"],
      message: "Read-only commands must use the read_only risk class",
    });
  }
  if (value.readOnly && value.confirmationPolicy !== "none") {
    context.addIssue({
      code: "custom",
      path: ["confirmationPolicy"],
      message: "Read-only commands must not request confirmation",
    });
  }
  if (!value.readOnly && value.idempotencyPolicy === "not_applicable") {
    context.addIssue({
      code: "custom",
      path: ["idempotencyPolicy"],
      message: "Mutating commands must define an idempotency policy",
    });
  }
  if (
    (value.destructive || value.financial || value.freshAuthRequired) &&
    value.confirmationPolicy !== "step_up"
  ) {
    context.addIssue({
      code: "custom",
      path: ["confirmationPolicy"],
      message: "Destructive, financial, and fresh-auth commands require step-up confirmation",
    });
  }
});

const assistantProductCardSchema = z.object({
  id: resourceReference,
  title: boundedText(240),
  path: safePath,
  imageUrl: z.url().max(1_000).refine(
    (value) => value.startsWith("https://") || value.startsWith("http://"),
    "Expected an HTTP(S) image URL",
  ).optional(),
  price: z.number().finite().nonnegative().optional(),
  compareAtPrice: z.number().finite().nonnegative().optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  pricePresentation: z.enum(["exact", "starting_at"]).optional(),
  availability: z.enum(["in_stock", "out_of_stock", "limited", "unknown"]),
  selectedVariantId: resourceReference.optional(),
  badges: z.array(boundedText(60)).max(6).default([]),
  rationale: boundedText(500).optional(),
}).strict().superRefine((value, context) => {
  if (
    (value.price !== undefined || value.compareAtPrice !== undefined) &&
    value.currency === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["currency"],
      message: "Currency is required when a product card includes money",
    });
  }
  if (
    (value.price === undefined) !== (value.pricePresentation === undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["pricePresentation"],
      message: "Price and price presentation must be provided together",
    });
  }
  if (
    value.compareAtPrice !== undefined &&
    (value.price === undefined ||
      value.pricePresentation !== "exact" ||
      value.compareAtPrice <= value.price)
  ) {
    context.addIssue({
      code: "custom",
      path: ["compareAtPrice"],
      message: "Compare-at price requires one exact paired product price",
    });
  }
});

const assistantComparisonCellSchema = z.object({
  productId: resourceReference,
  value: boundedText(500).nullable(),
  status: z.enum(["known", "unknown", "not_applicable"]).default("known"),
}).strict();

const assistantTableCellSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const assistantMessagePartSchemas = {
  text: z.object({
    type: z.literal("text"),
    text: boundedText(8_000),
  }).strict(),
  source: z.object({
    type: z.literal("source"),
    sourceId: opaqueId,
    label: boundedText(240),
    description: boundedText(600).optional(),
    path: safePath.optional(),
  }).strict(),
  productGrid: z.object({
    type: z.literal("product_grid"),
    title: boundedText(160).optional(),
    products: z.array(assistantProductCardSchema).min(1).max(12),
  }).strict(),
  comparison: z.object({
    type: z.literal("comparison"),
    title: boundedText(160),
    products: z.array(assistantProductCardSchema).min(2).max(6),
    rows: z.array(z.object({
      label: boundedText(120),
      cells: z.array(assistantComparisonCellSchema).min(2).max(6),
    }).strict()).min(1).max(20),
  }).strict(),
  table: z.object({
    type: z.literal("table"),
    title: boundedText(160),
    columns: z.array(z.object({
      key: capabilityId,
      label: boundedText(120),
      align: z.enum(["start", "center", "end"]).default("start"),
    }).strict()).min(1).max(20),
    rows: z.array(z.object({
      id: opaqueId,
      cells: z.record(z.string(), assistantTableCellSchema),
    }).strict()).max(200),
    truncated: z.boolean().default(false),
  }).strict(),
  chart: z.object({
    type: z.literal("chart"),
    title: boundedText(160),
    chartType: z.enum(["bar", "line", "area", "pie"]),
    xLabel: boundedText(80).optional(),
    yLabel: boundedText(80).optional(),
    series: z.array(z.object({
      id: opaqueId,
      label: boundedText(120),
      points: z.array(z.object({
        label: boundedText(120),
        value: z.number().finite(),
      }).strict()).min(1).max(100),
    }).strict()).min(1).max(12),
    textSummary: boundedText(2_000),
  }).strict(),
  formDraft: z.object({
    type: z.literal("form_draft"),
    title: boundedText(160),
    surfaceId: opaqueId,
    fields: z.array(z.object({
      field: capabilityId,
      label: boundedText(120),
      displayValue: z.string().max(1_000),
      sensitive: z.boolean().default(false),
    }).strict()).min(1).max(30),
  }).strict(),
  diff: z.object({
    type: z.literal("diff"),
    title: boundedText(160),
    changes: z.array(z.object({
      field: boundedText(160),
      before: z.string().max(1_000).nullable(),
      after: z.string().max(1_000).nullable(),
      impact: z.enum(["informational", "buyer_visible", "financial", "inventory", "security"]),
    }).strict()).min(1).max(100),
  }).strict(),
  confirmation: z.object({
    type: z.literal("confirmation"),
    actionId: opaqueId,
    title: boundedText(160),
    summary: boundedText(1_000),
    riskClass: assistantRiskClassSchema,
    consequences: z.array(boundedText(500)).max(20).default([]),
    confirmLabel: boundedText(80),
    expiresAt: z.number().int().positive(),
  }).strict(),
  progress: z.object({
    type: z.literal("progress"),
    workflowId: opaqueId,
    label: boundedText(200),
    status: assistantWorkflowStatusSchema,
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().positive().optional(),
  }).strict(),
  result: z.object({
    type: z.literal("result"),
    title: boundedText(160),
    summary: boundedText(2_000),
    status: z.enum(["succeeded", "partially_succeeded", "failed"]),
    resourcePath: safePath.optional(),
    undoActionId: opaqueId.optional(),
  }).strict(),
  export: z.object({
    type: z.literal("export"),
    title: boundedText(160),
    description: boundedText(600),
    format: z.enum(["csv", "xlsx", "pdf", "json"]),
    path: safePath,
    expiresAt: z.number().int().positive().optional(),
  }).strict(),
  error: z.object({
    type: z.literal("error"),
    code: capabilityId,
    message: boundedText(1_000),
    retryable: z.boolean(),
    retryActionId: opaqueId.optional(),
  }).strict(),
  navigation: z.object({
    type: z.literal("navigation"),
    path: safePath,
    label: boundedText(120),
    requiresConfirmation: z.boolean().default(true),
  }).strict(),
  handoff: z.object({
    type: z.literal("handoff"),
    title: boundedText(160),
    description: boundedText(1_000),
    path: safePath,
    handoffType: z.enum(["checkout", "payment", "authentication", "support", "manual"]),
  }).strict(),
  auth: z.object({
    type: z.literal("auth"),
    authType: z.enum(["sign_in", "step_up", "access_denied", "session_expired"]),
    title: boundedText(160),
    description: boundedText(1_000),
    path: safePath.optional(),
  }).strict(),
} as const;

export const assistantMessagePartSchema = z.discriminatedUnion("type", [
  assistantMessagePartSchemas.text,
  assistantMessagePartSchemas.source,
  assistantMessagePartSchemas.productGrid,
  assistantMessagePartSchemas.comparison,
  assistantMessagePartSchemas.table,
  assistantMessagePartSchemas.chart,
  assistantMessagePartSchemas.formDraft,
  assistantMessagePartSchemas.diff,
  assistantMessagePartSchemas.confirmation,
  assistantMessagePartSchemas.progress,
  assistantMessagePartSchemas.result,
  assistantMessagePartSchemas.export,
  assistantMessagePartSchemas.error,
  assistantMessagePartSchemas.navigation,
  assistantMessagePartSchemas.handoff,
  assistantMessagePartSchemas.auth,
]);

export const assistantMessageSchema = z.object({
  id: opaqueId,
  role: z.enum(["user", "assistant", "system", "tool"]),
  createdAt: z.number().int().positive(),
  parts: z.array(assistantMessagePartSchema).min(1).max(40),
}).strict();

export const assistantPrepareRequestSchema = z.object({
  protocolVersion: z.literal(ASSISTANT_PROTOCOL_VERSION),
  sessionId: opaqueId,
  workflowId: opaqueId.optional(),
  capability: capabilityId,
  arguments: z.record(z.string(), z.unknown()),
  expectedVersions: z.array(assistantVersionPreconditionSchema).max(100).default([]),
  clientRequestId: opaqueId,
}).strict();

export const assistantPreparedActionSchema = z.object({
  protocolVersion: z.literal(ASSISTANT_PROTOCOL_VERSION),
  actionId: opaqueId,
  sessionId: opaqueId,
  workflowId: opaqueId,
  capability: capabilityId,
  argumentsHash: sha256Hex,
  permission: boundedText(160).nullable(),
  riskClass: assistantRiskClassSchema,
  confirmationPolicy: assistantConfirmationPolicySchema,
  status: assistantActionStatusSchema,
  expiresAt: z.number().int().positive(),
  expectedVersions: z.array(assistantVersionPreconditionSchema).max(100),
  affectedCount: z.number().int().nonnegative().optional(),
  monetaryValue: z.number().finite().nonnegative().optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  parts: z.array(assistantMessagePartSchema).min(1).max(40),
}).strict();

export const assistantConfirmRequestSchema = z.object({
  protocolVersion: z.literal(ASSISTANT_PROTOCOL_VERSION),
  actionId: opaqueId,
  argumentsHash: sha256Hex,
  clientRequestId: opaqueId,
  acknowledgement: boundedText(240).optional(),
}).strict();

export const assistantApprovalReceiptSchema = z.object({
  protocolVersion: z.literal(ASSISTANT_PROTOCOL_VERSION),
  actionId: opaqueId,
  approvalToken: boundedText(1_000),
  approvedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict();

export const assistantExecuteRequestSchema = z.object({
  protocolVersion: z.literal(ASSISTANT_PROTOCOL_VERSION),
  actionId: opaqueId,
  argumentsHash: sha256Hex,
  approvalToken: boundedText(1_000).optional(),
  idempotencyKey: opaqueId,
  clientRequestId: opaqueId,
}).strict();

export const assistantActionResultSchema = z.object({
  protocolVersion: z.literal(ASSISTANT_PROTOCOL_VERSION),
  actionId: opaqueId,
  workflowId: opaqueId,
  status: z.enum(["succeeded", "failed"]),
  replayed: z.boolean(),
  completedAt: z.number().int().positive(),
  parts: z.array(assistantMessagePartSchema).min(1).max(40),
}).strict();

export const assistantWorkflowEventSchema = z.object({
  protocolVersion: z.literal(ASSISTANT_PROTOCOL_VERSION),
  eventId: opaqueId,
  workflowId: opaqueId,
  sequence: z.number().int().positive(),
  status: assistantWorkflowStatusSchema,
  type: capabilityId,
  occurredAt: z.number().int().positive(),
  parts: z.array(assistantMessagePartSchema).max(40).default([]),
}).strict();

export type AssistantCommandDescriptor = z.infer<typeof assistantCommandDescriptorSchema>;
export type AssistantMessagePart = z.infer<typeof assistantMessagePartSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type AssistantPrepareRequest = z.infer<typeof assistantPrepareRequestSchema>;
export type AssistantPreparedAction = z.infer<typeof assistantPreparedActionSchema>;
export type AssistantConfirmRequest = z.infer<typeof assistantConfirmRequestSchema>;
export type AssistantApprovalReceipt = z.infer<typeof assistantApprovalReceiptSchema>;
export type AssistantExecuteRequest = z.infer<typeof assistantExecuteRequestSchema>;
export type AssistantActionResult = z.infer<typeof assistantActionResultSchema>;
export type AssistantWorkflowEvent = z.infer<typeof assistantWorkflowEventSchema>;
export type AssistantVersionPrecondition = z.infer<typeof assistantVersionPreconditionSchema>;

const TERMINAL_WORKFLOW_STATUSES = new Set<AssistantWorkflowStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalAssistantWorkflowStatus(status: AssistantWorkflowStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

export function assistantRiskRequiresExplicitConfirmation(risk: AssistantRiskClass): boolean {
  return risk === "consequential" || risk === "high_risk";
}
