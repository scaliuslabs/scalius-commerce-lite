import type {
  AgentOperationIdempotency,
  AgentOperationRevision,
} from "../../openapi/agent-operation-manifest";

export const AGENT_WORKFLOW_CATALOG_VERSION = "1.0.0" as const;

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

export type AgentWorkflowStepPolicies = {
  revision: AgentOperationRevision;
  idempotency: AgentOperationIdempotency;
  confirmation: "none" | "required";
  stopConditions: string[];
  nonInferenceRules: string[];
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
  };
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
  coverage: {
    policy: "curated-first-operation-fallback";
    fallback: AgentWorkflowFallbackContract;
    operations: AgentWorkflowCoverageEntry[];
  };
};
