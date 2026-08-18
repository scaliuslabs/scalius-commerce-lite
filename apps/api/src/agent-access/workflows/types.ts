import type {
  AgentOperationIdempotency,
  AgentOperationRevision,
} from "../../openapi/agent-operation-manifest";

export const AGENT_WORKFLOW_CATALOG_VERSION = "3.0.0" as const;

export const AGENT_PRODUCT_CONSTRUCTION_RULES = {
  mediaAssociationIds: "caller-local-pmed",
  variantImageReferences: "pmed-association-id",
  selectedOptionValueOrder: "merchant-axis-order",
  variantMatrix: "complete",
  skuIdentity: "global-lower-trim-unique",
  inventoryAuthority: "variant-only-no-product-stock",
  createMode: "single-atomic-products.create",
  uncertainCreateRecovery: "reread-before-retry",
} as const;

export type AgentProductConstructionRules =
  typeof AGENT_PRODUCT_CONSTRUCTION_RULES;

export type AgentWorkflowSurface = "dashboard" | "storefront";
export type AgentWorkflowIntentKind = "read" | "write" | "mixed";
export type AgentWorkflowDisposition = "execute" | "ask" | "unsupported" | "refuse";
export type AgentWorkflowMutationSemantics =
  | "read"
  | "create"
  | "partial"
  | "replace"
  | "command"
  | "lifecycle";

export type AgentWorkflowOperationFactReference = {
  operationId: string;
  responsePointer: string;
};

export type AgentWorkflowFactSource =
  | { kind: "merchant" }
  | {
      kind: "operation";
      operationId: string;
      responsePointer: string;
      alternatives?: AgentWorkflowOperationFactReference[];
    }
  | { kind: "constant"; value: unknown };

export type AgentWorkflowRequiredFact = {
  id: string;
  title: string;
  description: string;
  required: boolean;
  defaultValue?: unknown;
  source: AgentWorkflowFactSource;
  nonInferenceRule: string;
};

export type AgentWorkflowDependencySource =
  | {
      kind: "fact";
      factId: string;
      factPointer?: string;
    }
  | {
      kind: "step";
      phaseId: string;
      stepId: string;
      responsePointer: string;
    };

export type AgentWorkflowInputDependency = {
  templatePointer: string;
  source: AgentWorkflowDependencySource;
};

export type AgentWorkflowInputDefault = {
  templatePointer: string;
  value: unknown;
};

export type AgentWorkflowInputFactPick = {
  /** Merchant-authoritative object fact whose root properties are selected. */
  factId: string;
  /** Fixed pointer to an operation-input object. */
  templatePointer: string;
  /** Exact property names copied fact[key] -> input object[key]. */
  keys: string[];
};

export type AgentWorkflowInputMaterialization = {
  /** Merchant-authoritative fact containing ordered keys and keyed items. */
  factId: string;
  /** Fixed pointer to an empty operation-input array. */
  templatePointer: string;
  /** Fixed pointer to the array of scalar item keys. */
  orderPointer: string;
  /** Fixed pointer to the object indexed by each ordered key. */
  itemMapPointer: string;
  minItems: number;
  maxItems: number;
  /** Optional output property receiving the current ordered key. */
  keyField?: string;
  /** Exact property names copied keyedItem[key] -> output item[key]. */
  keys: string[];
};

export type AgentWorkflowRepeatBinding = {
  /** Fixed pointer to one operation-input template value. */
  templatePointer: string;
  /** Fixed pointer relative to the item selected by the current ordered key. */
  itemPointer: string;
};

export type AgentWorkflowRepeat = {
  /** Merchant-authoritative fact containing the ordered keys and keyed items. */
  factId: string;
  /** Fixed pointer to the array of scalar item keys. */
  orderPointer: string;
  /** Fixed pointer to the object indexed by each ordered key. */
  itemMapPointer: string;
  minItems: number;
  maxItems: number;
  bindings: AgentWorkflowRepeatBinding[];
  capture: {
    /** Fixed pointer to one scalar operation-response value. */
    responsePointer: string;
    /** Fixed pointer written into the same selected fact item. */
    itemPointer: string;
  };
};

export type AgentWorkflowStepPolicies = {
  revision: AgentOperationRevision;
  idempotency: AgentOperationIdempotency;
  confirmation: "none" | "required";
  stopConditions: string[];
  nonInferenceRules: string[];
};

export type AgentWorkflowOutputField = {
  /** Fixed JSON Pointer relative to the selected object or array item. */
  pointer: string;
  alias: string;
};

export type AgentWorkflowOutputSelector = {
  /** Fixed JSON Pointer from the operation response root. */
  pointer: string;
  alias: string;
  /** Required for arrays and forbidden for non-arrays. */
  maxItems?: number;
  /** Optional exact raw array cardinality; must equal maxItems. */
  exactItems?: number;
  /** Required for object values/items and forbidden for scalar values/items. */
  fields?: AgentWorkflowOutputField[];
};

export type AgentWorkflowOutputProjection = {
  selectors: AgentWorkflowOutputSelector[];
};

export type AgentWorkflowStep = {
  id: string;
  title: string;
  operationId: string;
  mutation: AgentWorkflowMutationSemantics;
  condition?: string;
  input: {
    template: unknown;
    dependencies: AgentWorkflowInputDependency[];
    defaults: AgentWorkflowInputDefault[];
    picks?: AgentWorkflowInputFactPick[];
    materializations?: AgentWorkflowInputMaterialization[];
  };
  repeat?: AgentWorkflowRepeat;
  output?: AgentWorkflowOutputProjection;
  policies: AgentWorkflowStepPolicies;
};

export type AgentWorkflowPhase = {
  id: string;
  surface: AgentWorkflowSurface;
  title: string;
  summary: string;
  dependsOn: string[];
  steps: AgentWorkflowStep[];
  stopConditions: string[];
};

export type AgentWorkflowVerificationEvidence = {
  id: string;
  surface: AgentWorkflowSurface;
  operationId: string;
  responsePointers: string[];
  proves: string[];
  bounds: {
    maxCalls: number;
    maxItems?: number;
    maxResponseBytes: number;
  };
};

export type AgentWorkflowCard = {
  id: string;
  surface: AgentWorkflowSurface;
  title: string;
  summary: string;
  examples: string[];
  tags: string[];
  constructionRules?: AgentProductConstructionRules;
  requiredFacts: AgentWorkflowRequiredFact[];
  phases: AgentWorkflowPhase[];
  verification: AgentWorkflowVerificationEvidence[];
};

/**
 * Compact reviewed routing metadata. Routes choose the smallest known
 * operation sequence; detailed cards remain the authority for executable
 * templates, dependencies, and projections.
 */
export type AgentWorkflowIntentRoute = {
  id: string;
  surface: AgentWorkflowSurface;
  kind: AgentWorkflowIntentKind;
  title: string;
  summary: string;
  examples: string[];
  tags: string[];
  workflowId?: string;
  /** Fixed merchant-calendar window; explicit N-day mismatches must not execute this route. */
  fixedCalendarDays?: number;
  operationIds: string[];
  requiresFacts: boolean;
  requiresConfirmation: boolean;
  requiresVerification: boolean;
  rules: string[];
};

export type AgentWorkflowControlTriggerBranch = {
  /** Every group requires at least one listed phrase. */
  allOf: string[][];
};

/** Base allOf groups are required; when present, at least one anyOf branch must also match. */
export type AgentWorkflowControlTrigger = {
  allOf: string[][];
  anyOf?: AgentWorkflowControlTriggerBranch[];
  ignoreWhenNegated: boolean;
  /** Cooperative phrases that exempt an otherwise unsupported-only request. */
  noneOf?: string[];
};

export type AgentWorkflowControl = {
  id: string;
  surface: AgentWorkflowSurface | "any";
  title: string;
  summary: string;
  examples: string[];
  tags: string[];
  disposition: Exclude<AgentWorkflowDisposition, "execute">;
  reasonCode: string;
  trigger: AgentWorkflowControlTrigger;
  safeOperationIds: string[];
  forbiddenOperationIds: string[];
  requiresFacts: boolean;
  requiresConfirmation: boolean;
  requiresVerification: boolean;
  rules: string[];
};

export type AgentWorkflowCoverageEntry = {
  operationId: string;
  surface: AgentWorkflowSurface;
  mode: "curated" | "operation-fallback";
  workflowIds: string[];
};

export type AgentWorkflowFallbackContract = {
  workflowIdTemplate: "operation.{operationId}";
  operationPointerTemplate: string;
  inputSchemaPointerTemplate: string;
  policyPointers: {
    revision: string;
    idempotency: string;
    risk: string;
    confirmation: string;
  };
  rules: {
    confirmEveryMutation: true;
    stopOnConflict: true;
    stopOnAuthorizationFailure: true;
    neverInferRequiredInput: true;
    verifyMutationsWithBoundedRead: true;
  };
};

export type AgentWorkflowCatalog = {
  version: typeof AGENT_WORKFLOW_CATALOG_VERSION;
  cards: AgentWorkflowCard[];
  routes: AgentWorkflowIntentRoute[];
  controls: AgentWorkflowControl[];
  coverage: {
    policy: "curated-first-operation-fallback";
    fallback: AgentWorkflowFallbackContract;
    operations: AgentWorkflowCoverageEntry[];
  };
};
