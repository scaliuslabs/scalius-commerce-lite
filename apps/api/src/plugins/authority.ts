// Plugin principals (packages/plugin-sdk/docs/apps.md, "Execution boundary"): a plugin
// calls `/api/v1` operations through the same dispatcher and admin
// authorization as agents (agent-access/dispatch.ts), as itself.
//
// Which operations a plugin may ever call is decided from operation metadata,
// never from operation-id strings:
//   - a dashboard operation, executable, plain JSON, under /api/v1/admin;
//   - not `security` risk, no sensitive or one-time-secret output, no
//     artifact, continuation or client-action transport;
//   - guarded by RBAC permissions (not super-admin-only, public or unmapped),
//     every one of them plugin-grantable (no team, agent access, webhook or
//     plugin management: `PLUGIN_RESERVED_PERMISSION_RESOURCES`);
//   - in the app's tier (`x-scalius-agent.stability`): a third-party app
//     calls `stable` operations only, a bundled first-party app also `beta`,
//     no app `internal`.
// Within that set the installation's grant (its scopes, expanded to RBAC by
// `PLUGIN_SCOPES`) decides, and the risk ceiling is the highest risk the
// grant unlocks.

import type { Database } from "@scalius/database/client";
import { user } from "@scalius/database/schema";
import {
  effectivePluginPermissions,
  getActivePluginInstallation,
  isFirstPartyBundledPlugin,
  isPluginGrantablePermission,
} from "@scalius/core/modules/plugins";
import { grantedProtectedData } from "@scalius/shared/plugins/protected-data";
import { PLUGIN_MESSAGE_ANY_SCOPE } from "@scalius/shared/plugins/messaging";
import { pluginMessageRecipientKey } from "@scalius/shared/plugins/manifest";
import { eq } from "drizzle-orm";
import { AGENT_OPERATION_POLICIES } from "../generated/agent-operation-policies.gen";
import type { AgentOperationPolicy, AgentOperationRbac, AgentOperationStability } from "../openapi/agent-operation-manifest";
import { isAgentRiskAllowed, type AgentRisk, type PluginPrincipal } from "../agent-access/types";
import { isWithinRateLimit } from "../utils/rate-limit";

const RISK_ORDER: readonly AgentRisk[] = ["read", "write", "destructive", "financial", "security"];

/** Whether an app of this tier may call an operation of this stability. */
export function pluginTierAllows(firstParty: boolean, stability: AgentOperationStability): boolean {
  return stability === "stable" || (stability === "beta" && firstParty);
}

function rbacPermissions(rbac: AgentOperationRbac): string[] | null {
  switch (rbac.type) {
    case "permission":
      return [rbac.permission];
    case "anyOf":
    case "allOf":
      return rbac.permissions;
    default:
      return null;
  }
}

/**
 * Whether some app may ever call this operation, whatever its grant and tier
 * (a third-party app further needs it `stable`: `isOperationAvailableToPlugin`).
 */
export function isOperationAvailableToPlugins(operation: AgentOperationPolicy): boolean {
  if (operation.stability === "internal") return false;
  if (operation.surface !== "dashboard" || operation.exposure !== "execute") return false;
  if (!operation.pathTemplate.startsWith("/api/v1/admin/")) return false;
  if (!operation.principals.includes("admin")) return false;
  if (operation.transport !== "json" || operation.artifactOutput || operation.continuationOutput || operation.requiredClientAction) return false;
  if (operation.risk === "security" || operation.sensitiveOutput || operation.oneTimeSecretOutput) return false;
  const permissions = rbacPermissions(operation.rbac);
  return permissions !== null && permissions.length > 0 && permissions.every(isPluginGrantablePermission);
}

/** Whether an app of this tier may ever call this operation, whatever its grant. */
export function isOperationAvailableToPlugin(operation: AgentOperationPolicy, firstParty: boolean): boolean {
  return pluginTierAllows(firstParty, operation.stability) && isOperationAvailableToPlugins(operation);
}

export function pluginRbacSatisfied(rbac: AgentOperationRbac, permissions: ReadonlySet<string>): boolean {
  switch (rbac.type) {
    case "permission":
      return permissions.has(rbac.permission);
    case "anyOf":
      return rbac.permissions.some((permission) => permissions.has(permission));
    case "allOf":
      return rbac.permissions.every((permission) => permissions.has(permission));
    default:
      return false;
  }
}

/**
 * The highest risk among the operations an app of this tier may call that the
 * permissions unlock (`read` when they unlock none). Never `security`.
 */
export function derivePluginRiskCeiling(
  permissions: ReadonlySet<string>,
  firstParty: boolean,
  operations: readonly AgentOperationPolicy[] = AGENT_OPERATION_POLICIES,
): AgentRisk {
  let ceiling = 0;
  for (const operation of operations) {
    if (!isOperationAvailableToPlugin(operation, firstParty) || !pluginRbacSatisfied(operation.rbac, permissions)) continue;
    ceiling = Math.max(ceiling, RISK_ORDER.indexOf(operation.risk));
  }
  return RISK_ORDER[Math.min(ceiling, RISK_ORDER.indexOf("financial"))]!;
}

/** Tier and availability, risk ceiling and grant, in that order. */
export function authorizePluginOperation(principal: PluginPrincipal, operation: AgentOperationPolicy): boolean {
  return isOperationAvailableToPlugin(operation, principal.firstParty)
    && isAgentRiskAllowed(principal.riskCeiling, operation.risk)
    && pluginRbacSatisfied(operation.rbac, principal.permissions);
}

/**
 * The live principal of an active installation, or null: not installed, not
 * active, no approved grant, or its approving Super Admin no longer exists or
 * is banned (route writes are recorded as that user, so a Super Admin must
 * approve the plugin again).
 */
export async function resolvePluginPrincipal(db: Database, pluginId: string): Promise<PluginPrincipal | null> {
  const installation = await getActivePluginInstallation(db, pluginId);
  if (!installation?.grant || !installation.activatedBy) return null;
  const actor = await db.select({ id: user.id, banned: user.banned, banExpires: user.banExpires })
    .from(user).where(eq(user.id, installation.activatedBy)).get();
  if (!actor) return null;
  if (actor.banned && !(actor.banExpires && actor.banExpires.getTime() <= Date.now())) return null;
  const permissions = effectivePluginPermissions(installation.grant);
  const firstParty = isFirstPartyBundledPlugin(installation);
  return {
    kind: "plugin",
    pluginId: installation.pluginId,
    version: installation.version,
    pluginName: installation.manifest.name,
    actorUserId: actor.id,
    firstParty,
    permissions,
    protectedData: grantedProtectedData(installation.grant.scopes),
    riskCeiling: derivePluginRiskCeiling(permissions, firstParty),
    messaging: {
      anyAddress: installation.grant.scopes.includes(PLUGIN_MESSAGE_ANY_SCOPE),
      recipients: installation.manifest.messaging.recipients
        .filter((recipient) => installation.grant!.messageRecipients.includes(pluginMessageRecipientKey(recipient))),
    },
  };
}

/** Every plugin shares the standard limiter (60 operation calls a minute), keyed per plugin. */
export function pluginWithinRateLimit(env: Env, purpose: "api" | "http", pluginId: string): Promise<boolean> {
  if (!env.RL_STANDARD) return Promise.resolve(false);
  return isWithinRateLimit(env, "RL_STANDARD", `plugin-${purpose}`, pluginId);
}

/**
 * The app's messages a minute (`planLimits().plugins.messagesPerMinute`):
 * the standard limiter (60 a minute per key) over that many / 60 shards
 * picked at random. Fails closed: without the binding nothing is sent.
 */
export async function pluginWithinMessageRate(env: Env, pluginId: string, perMinute: number): Promise<boolean> {
  if (!env.RL_STANDARD) return false;
  const shards = Math.max(1, Math.ceil(perMinute / 60));
  const shard = shards === 1 ? 0 : crypto.getRandomValues(new Uint32Array(1))[0]! % shards;
  try {
    return await isWithinRateLimit(env, "RL_STANDARD", "plugin-messaging", shards === 1 ? pluginId : `${pluginId}:${shard}`);
  } catch {
    return false;
  }
}
