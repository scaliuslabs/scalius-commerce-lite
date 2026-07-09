import type { Context } from "hono";
import {
  constantTimeAssistantHashEqual,
  hashAssistantArguments,
  resumeAssistantSession,
  type AssistantSessionView,
  type AssistantWorkflowView,
} from "@scalius/core/modules/assistant";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@scalius/core/errors";
import type { AssistantRiskClass } from "@scalius/shared/assistant-contracts";
import {
  ADMIN_COMMAND_POLICY_DIGEST,
  ADMIN_COMMAND_REGISTRY,
  describeAdminCapability,
  type AdminCommandDescriptor,
} from "../../modules/assistant";

const ADMIN_SESSION_METADATA_VERSION = 1;

export interface AdminAssistantAuthorityContext {
  actorId: string;
  dashboardSessionId: string;
  dashboardSessionHash: string;
  permissions: ReadonlySet<string>;
  permissionSnapshotHash: string;
}

export async function resolveAdminAssistantAuthorityContext(
  c: Context<{ Bindings: Env }>,
): Promise<AdminAssistantAuthorityContext> {
  const user = c.get("user");
  const dashboardSession = c.get("session");
  const permissions = c.get("adminPermissions");
  const actorId = user?.id?.trim();
  const dashboardSessionId = dashboardSession?.id?.trim();

  if (!actorId || !dashboardSessionId || !(permissions instanceof Set)) {
    throw new UnauthorizedError(
      "An active dashboard session is required for assistant authority.",
    );
  }

  const sortedPermissions = [...permissions].sort();
  if (sortedPermissions.length === 0) {
    throw new ForbiddenError("Admin access is required.");
  }

  const [dashboardSessionHash, permissionSnapshotHash] = await Promise.all([
    hashAssistantArguments({
      version: "admin-assistant-dashboard-session:v1",
      dashboardSessionId,
    }),
    hashAssistantArguments({
      version: "admin-assistant-permission-snapshot:v1",
      surface: "admin",
      actorId,
      permissions: sortedPermissions,
      commandPolicyDigest: ADMIN_COMMAND_POLICY_DIGEST,
    }),
  ]);

  return {
    actorId,
    dashboardSessionId,
    dashboardSessionHash,
    permissions: new Set(sortedPermissions),
    permissionSnapshotHash,
  };
}

export function adminAssistantSessionMetadata(
  context: AdminAssistantAuthorityContext,
) {
  return {
    schemaVersion: ADMIN_SESSION_METADATA_VERSION,
    dashboardSessionHash: context.dashboardSessionHash,
  } as const;
}

export async function requireCurrentAdminAssistantSession(
  c: Context<{ Bindings: Env }>,
  credential: string,
  context: AdminAssistantAuthorityContext,
): Promise<AssistantSessionView> {
  const session = await resumeAssistantSession(c.get("db"), {
    credential,
    expectedSurface: "admin",
    expectedActorId: context.actorId,
    expectedPermissionSnapshotHash: context.permissionSnapshotHash,
    expectedSafeMetadata: adminAssistantSessionMetadata(context),
  });
  assertCurrentAdminAssistantSession(session, context);
  return session;
}

export function assertCurrentAdminAssistantSession(
  session: AssistantSessionView,
  context: AdminAssistantAuthorityContext,
): void {
  if (
    session.surface !== "admin" ||
    session.actorType !== "admin" ||
    session.actorId !== context.actorId ||
    !hasCurrentDashboardSessionMetadata(
      session.safeMetadata,
      context.dashboardSessionHash,
    )
  ) {
    throw new UnauthorizedError(
      "Assistant session is unavailable for this dashboard session.",
    );
  }

  const storedPermissionHash = session.permissionSnapshotHash;
  if (
    !storedPermissionHash ||
    !constantTimeAssistantHashEqual(
      storedPermissionHash,
      context.permissionSnapshotHash,
    )
  ) {
    throw new ForbiddenError(
      "Admin permissions changed; create a new assistant session.",
    );
  }
}

export function isAdminCapabilityAuthorized(
  descriptor: AdminCommandDescriptor,
  permissions: ReadonlySet<string>,
): boolean {
  switch (descriptor.authorization.kind) {
    case "any-admin":
      return permissions.size > 0;
    case "permission":
      return permissions.has(descriptor.authorization.permission);
    case "any-of":
      return descriptor.authorization.permissions.some((permission) =>
        permissions.has(permission)
      );
    case "all-of":
      return descriptor.authorization.permissions.every((permission) =>
        permissions.has(permission)
      );
  }
}

export function requireAuthorizedAdminCapability(
  capabilityId: string,
  permissions: ReadonlySet<string>,
): AdminCommandDescriptor {
  const descriptor = describeAdminCapability(capabilityId);
  if (!descriptor || !isAdminCapabilityAuthorized(descriptor, permissions)) {
    throw new NotFoundError("Admin assistant capability not found.");
  }
  return descriptor;
}

export function searchAuthorizedAdminCapabilities(
  input: {
    query: string;
    limit: number;
    readOnly?: boolean;
    implementation?: AdminCommandDescriptor["implementation"];
  },
  permissions: ReadonlySet<string>,
) {
  const query = input.query.toLowerCase();
  return ADMIN_COMMAND_REGISTRY.filter((descriptor) =>
    isAdminCapabilityAuthorized(descriptor, permissions)
  ).filter((descriptor) =>
    input.readOnly === undefined || descriptor.flags.readOnly === input.readOnly
  ).filter((descriptor) =>
    !input.implementation || descriptor.implementation === input.implementation
  ).filter((descriptor) =>
    !query || `${descriptor.id} ${descriptor.operationKey}`
      .toLowerCase()
      .includes(query)
  ).slice(0, input.limit).map(compactAdminCapability);
}

export function compactAdminCapability(descriptor: AdminCommandDescriptor) {
  const evidence = descriptor.idempotency.evidence;
  const idempotencyProven = evidence.kind === "not-applicable" ||
    evidence.kind === "inherent" ||
    (evidence.kind === "adapter" && evidence.implemented);

  return {
    schemaVersion: descriptor.schemaVersion,
    id: descriptor.id,
    method: descriptor.method,
    pathTemplate: descriptor.pathTemplate,
    implementation: descriptor.implementation,
    flags: { ...descriptor.flags },
    risk: descriptor.risk,
    confirmation: descriptor.confirmation,
    idempotency: {
      policy: descriptor.idempotency.policy,
      proven: idempotencyProven,
    },
    preview: {
      required: descriptor.preview.required,
      supported: descriptor.preview.supported,
      dryRunSupported: descriptor.preview.dryRunSupported,
    },
    execution: {
      enabled: descriptor.execution.enabled,
      readiness: descriptor.execution.readiness,
      blockers: [...descriptor.execution.blockers],
    },
    secretHandling: descriptor.secretHandling,
    input: { ...descriptor.input },
    result: { ...descriptor.result },
    auditCategory: descriptor.auditCategory,
    concurrency: descriptor.concurrency,
  } as const;
}

export function assistantRiskForCapability(
  descriptor: AdminCommandDescriptor,
): AssistantRiskClass {
  switch (descriptor.risk) {
    case "R0":
      return "read_only";
    case "R1":
      return "reversible";
    case "R2":
      return "consequential";
    case "R3":
      return "high_risk";
  }
}

export function safeWorkflowPlanForCapability(
  descriptor: AdminCommandDescriptor,
) {
  return [{
    type: "text" as const,
    text: descriptor.execution.enabled
      ? `Plan ${descriptor.id} through its typed authority adapter.`
      : `Plan ${descriptor.id}; execution is unavailable until its required controls are implemented.`,
  }];
}

export function compactAssistantSession(session: AssistantSessionView) {
  return {
    id: session.id,
    surface: session.surface,
    status: session.status,
    lastEventSequence: session.lastEventSequence,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
  } as const;
}

export function compactAssistantWorkflow(workflow: AssistantWorkflowView) {
  return {
    id: workflow.id,
    sessionId: workflow.sessionId,
    clientRequestId: workflow.clientRequestId,
    intent: workflow.intent,
    status: workflow.status,
    riskClass: workflow.riskClass,
    currentStep: workflow.currentStep,
    safePlan: workflow.safePlan,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  } as const;
}

function hasCurrentDashboardSessionMetadata(
  value: unknown,
  expectedHash: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return metadata.schemaVersion === ADMIN_SESSION_METADATA_VERSION &&
    typeof metadata.dashboardSessionHash === "string" &&
    constantTimeAssistantHashEqual(
      metadata.dashboardSessionHash,
      expectedHash,
    );
}
