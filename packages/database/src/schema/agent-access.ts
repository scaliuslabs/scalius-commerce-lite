// Durable authorization, audit, and storefront workflow state for agent access.
// OAuth protocol artifacts remain in the dedicated OAuth KV namespace; these
// tables are the provider-neutral product authority shared by D1, TursoDB, and
// PostgreSQL.

import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    type AnySQLiteColumn,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth";
import { customerSessions } from "./customers";
import { orders, paymentSessionAttempts } from "./orders";
import { UNIX_NOW } from "./shared";

const agentIdCheck = (column: ReturnType<typeof text>, prefix: string) =>
    sql`length(${column}) = ${sql.raw(String(prefix.length + 20))} AND substr(${column}, 1, ${sql.raw(String(prefix.length))}) = ${sql.raw(`'${prefix}'`)}`;

const jsonArrayCheck = (column: ReturnType<typeof text>) =>
    sql`json_valid(${column}) AND json_type(${column}) = 'array'`;

const jsonObjectCheck = (column: ReturnType<typeof text>) =>
    sql`json_valid(${column}) AND json_type(${column}) = 'object'`;

export const agentGrants = sqliteTable("agent_grants", {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["oauth", "pat", "cli"] }).notNull(),
    ownerUserId: text("owner_user_id")
        .references(() => user.id, { onDelete: "set null" }),
    resource: text("resource", { enum: ["dashboard", "storefront"] }).notNull(),
    label: text("label").notNull(),
    oauthClientId: text("oauth_client_id"),
    oauthClientName: text("oauth_client_name"),
    oauthRedirectUrisJson: text("oauth_redirect_uris_json"),
    preset: text("preset", { enum: ["read", "operator", "full", "custom"] }).notNull(),
    permissionsJson: text("permissions_json").notNull().default("[]"),
    riskCeiling: text("risk_ceiling", {
        enum: ["read", "write", "destructive", "financial", "security"],
    }).notNull(),
    status: text("status", { enum: ["pending", "active", "revoked"] })
        .notNull()
        .default("pending"),
    authorityRevision: integer("authority_revision").notNull().default(1),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    lastOperationId: text("last_operation_id"),
    revokedByUserId: text("revoked_by_user_id")
        .references(() => user.id, { onDelete: "set null" }),
    revokedReason: text("revoked_reason"),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("agent_grants_owner_status_idx").on(table.ownerUserId, table.status),
    index("agent_grants_resource_status_expiry_idx")
        .on(table.resource, table.status, table.expiresAt),
    index("agent_grants_status_expiry_idx").on(table.status, table.expiresAt),
    index("agent_grants_last_used_idx").on(table.lastUsedAt),
    check("agent_grants_id_shape", agentIdCheck(table.id, "agr_")),
    check("agent_grants_kind", sql`${table.kind} IN ('oauth', 'pat', 'cli')`),
    check("agent_grants_resource", sql`${table.resource} IN ('dashboard', 'storefront')`),
    check("agent_grants_label", sql`length(trim(${table.label})) BETWEEN 1 AND 120`),
    check("agent_grants_preset", sql`${table.preset} IN ('read', 'operator', 'full', 'custom')`),
    check(
        "agent_grants_permissions_json",
        sql`${jsonArrayCheck(table.permissionsJson)} AND length(${table.permissionsJson}) BETWEEN 2 AND 65536`,
    ),
    check(
        "agent_grants_risk_ceiling",
        sql`${table.riskCeiling} IN ('read', 'write', 'destructive', 'financial', 'security')`,
    ),
    check("agent_grants_status", sql`${table.status} IN ('pending', 'active', 'revoked')`),
    check("agent_grants_authority_revision", sql`${table.authorityRevision} > 0`),
    check("agent_grants_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
        "agent_grants_oauth_metadata",
        sql`(
            ${table.kind} = 'oauth'
            AND ${table.oauthClientId} IS NOT NULL
            AND ${table.oauthRedirectUrisJson} IS NOT NULL
            AND ${jsonArrayCheck(table.oauthRedirectUrisJson)}
        ) OR (
            ${table.kind} IN ('pat', 'cli')
            AND ${table.oauthClientId} IS NULL
            AND ${table.oauthClientName} IS NULL
            AND ${table.oauthRedirectUrisJson} IS NULL
        )`,
    ),
    check(
        "agent_grants_revocation_state",
        sql`(
            ${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL
        ) OR (
            ${table.status} <> 'revoked'
            AND ${table.revokedAt} IS NULL
            AND ${table.revokedByUserId} IS NULL
            AND ${table.revokedReason} IS NULL
        )`,
    ),
]);

export const agentCredentials = sqliteTable("agent_credentials", {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
        .notNull()
        .references(() => agentGrants.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["pat", "cli"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenHint: text("token_hint").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    rotatedAt: integer("rotated_at", { mode: "timestamp" }),
    rotatedFromId: text("rotated_from_id")
        .references((): AnySQLiteColumn => agentCredentials.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("agent_credentials_token_hash_uq").on(table.tokenHash),
    index("agent_credentials_grant_expiry_idx").on(table.grantId, table.expiresAt),
    index("agent_credentials_active_expiry_idx").on(table.revokedAt, table.expiresAt),
    index("agent_credentials_rotated_from_idx").on(table.rotatedFromId),
    check("agent_credentials_id_shape", agentIdCheck(table.id, "agc_")),
    check("agent_credentials_kind", sql`${table.kind} IN ('pat', 'cli')`),
    check("agent_credentials_token_hash", sql`length(${table.tokenHash}) = 64`),
    check("agent_credentials_token_hint", sql`length(${table.tokenHint}) BETWEEN 12 AND 120`),
    check("agent_credentials_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
        "agent_credentials_rotation_state",
        sql`${table.rotatedAt} IS NULL OR ${table.revokedAt} IS NOT NULL`,
    ),
]);

export const agentArtifactHandles = sqliteTable("agent_artifact_handles", {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
        .notNull()
        .references(() => agentGrants.id, { onDelete: "no action" }),
    credentialId: text("credential_id")
        .references(() => agentCredentials.id, { onDelete: "no action" }),
    resource: text("resource", { enum: ["dashboard", "storefront"] }).notNull(),
    operationId: text("operation_id").notNull(),
    r2Key: text("r2_key").notNull(),
    mediaType: text("media_type").notNull(),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status", { enum: ["active", "consumed", "expired", "failed"] })
        .notNull()
        .default("active"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    claimedAt: integer("claimed_at", { mode: "timestamp" }),
    failureClass: text("failure_class"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("agent_artifact_handles_r2_key_uq").on(table.r2Key),
    index("agent_artifact_handles_grant_status_expiry_idx")
        .on(table.grantId, table.status, table.expiresAt),
    index("agent_artifact_handles_status_expiry_idx").on(table.status, table.expiresAt),
    check("agent_artifact_handles_id_shape", agentIdCheck(table.id, "aah_")),
    check(
        "agent_artifact_handles_resource",
        sql`${table.resource} IN ('dashboard', 'storefront')`,
    ),
    check(
        "agent_artifact_handles_operation_id",
        sql`length(trim(${table.operationId})) BETWEEN 1 AND 240`,
    ),
    check(
        "agent_artifact_handles_r2_key",
        sql`length(trim(${table.r2Key})) BETWEEN 1 AND 240`,
    ),
    check(
        "agent_artifact_handles_media_type",
        sql`length(trim(${table.mediaType})) BETWEEN 1 AND 120 AND ${table.mediaType} NOT GLOB '*[^ -~]*'`,
    ),
    check(
        "agent_artifact_handles_filename",
        sql`length(trim(${table.filename})) BETWEEN 1 AND 160
            AND ${table.filename} NOT GLOB '*[^ -~]*'
            AND instr(${table.filename}, '/') = 0
            AND instr(${table.filename}, char(92)) = 0`,
    ),
    check(
        "agent_artifact_handles_size",
        sql`${table.sizeBytes} BETWEEN 1 AND 16777216`,
    ),
    check(
        "agent_artifact_handles_sha256",
        sql`length(${table.sha256}) = 64 AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
        "agent_artifact_handles_status",
        sql`${table.status} IN ('active', 'consumed', 'expired', 'failed')`,
    ),
    check(
        "agent_artifact_handles_expiry",
        sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + 300`,
    ),
    check(
        "agent_artifact_handles_claim_time",
        sql`${table.claimedAt} IS NULL OR (${table.claimedAt} >= ${table.createdAt} AND ${table.claimedAt} <= ${table.expiresAt})`,
    ),
    check(
        "agent_artifact_handles_failure_class",
        sql`${table.failureClass} IS NULL OR (
            length(${table.failureClass}) BETWEEN 1 AND 64
            AND ${table.failureClass} NOT GLOB '*[^a-z0-9_]*'
        )`,
    ),
    check(
        "agent_artifact_handles_state",
        sql`(
            ${table.status} IN ('active', 'expired')
            AND ${table.claimedAt} IS NULL
            AND ${table.failureClass} IS NULL
        ) OR (
            ${table.status} = 'consumed'
            AND ${table.claimedAt} IS NOT NULL
            AND ${table.failureClass} IS NULL
        ) OR (
            ${table.status} = 'failed'
            AND ${table.claimedAt} IS NOT NULL
            AND ${table.failureClass} IS NOT NULL
        )`,
    ),
]);

export const agentBrowserHandoffs = sqliteTable("agent_browser_handoffs", {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
        .notNull()
        .references(() => agentGrants.id, { onDelete: "no action" }),
    credentialId: text("credential_id")
        .references(() => agentCredentials.id, { onDelete: "no action" }),
    ownerUserId: text("owner_user_id")
        .notNull()
        .references(() => user.id, { onDelete: "no action" }),
    resource: text("resource", { enum: ["dashboard", "storefront"] }).notNull(),
    operationId: text("operation_id").notNull(),
    authorityRevision: integer("authority_revision").notNull(),
    encryptedAction: text("encrypted_action").notNull(),
    status: text("status", { enum: ["active", "consumed", "expired"] })
        .notNull()
        .default("active"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("agent_browser_handoffs_owner_status_expiry_idx")
        .on(table.ownerUserId, table.status, table.expiresAt),
    index("agent_browser_handoffs_grant_status_expiry_idx")
        .on(table.grantId, table.status, table.expiresAt),
    index("agent_browser_handoffs_status_expiry_idx").on(table.status, table.expiresAt),
    check("agent_browser_handoffs_id_shape", agentIdCheck(table.id, "abh_")),
    check(
        "agent_browser_handoffs_resource",
        sql`${table.resource} IN ('dashboard', 'storefront')`,
    ),
    check(
        "agent_browser_handoffs_operation_id",
        sql`length(trim(${table.operationId})) BETWEEN 1 AND 240`,
    ),
    check("agent_browser_handoffs_authority_revision", sql`${table.authorityRevision} > 0`),
    check(
        "agent_browser_handoffs_encrypted_action",
        sql`length(${table.encryptedAction}) BETWEEN 32 AND 8192`,
    ),
    check(
        "agent_browser_handoffs_status",
        sql`${table.status} IN ('active', 'consumed', 'expired')`,
    ),
    check(
        "agent_browser_handoffs_expiry",
        sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + 300`,
    ),
    check(
        "agent_browser_handoffs_state",
        sql`(
            ${table.status} IN ('active', 'expired') AND ${table.consumedAt} IS NULL
        ) OR (
            ${table.status} = 'consumed'
            AND ${table.consumedAt} IS NOT NULL
            AND ${table.consumedAt} >= ${table.createdAt}
            AND ${table.consumedAt} <= ${table.expiresAt}
        )`,
    ),
]);

export const agentAuthorizationRequests = sqliteTable("agent_authorization_requests", {
    id: text("id").primaryKey(),
    encryptedRequest: text("encrypted_request"),
    resource: text("resource", { enum: ["dashboard", "storefront"] }).notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name"),
    redirectUri: text("redirect_uri").notNull(),
    status: text("status", {
        enum: [
            "pending",
            "approved",
            "completing",
            "completed",
            "denying",
            "denied",
            "expired",
        ],
    })
        .notNull()
        .default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    decidedByUserId: text("decided_by_user_id")
        .references(() => user.id, { onDelete: "set null" }),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    grantId: text("grant_id")
        .references(() => agentGrants.id, { onDelete: "set null" }),
    completionClaimHash: text("completion_claim_hash"),
    completionClaimExpiresAt: integer("completion_claim_expires_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("agent_authorization_requests_status_expiry_idx")
        .on(table.status, table.expiresAt),
    index("agent_authorization_requests_client_created_idx")
        .on(table.clientId, table.createdAt),
    index("agent_authorization_requests_grant_idx").on(table.grantId),
    index("agent_authorization_requests_completion_claim_idx")
        .on(table.status, table.completionClaimExpiresAt),
    check("agent_authorization_requests_id_shape", agentIdCheck(table.id, "aar_")),
    check(
        "agent_authorization_requests_resource",
        sql`${table.resource} IN ('dashboard', 'storefront')`,
    ),
    check(
        "agent_authorization_requests_status",
        sql`${table.status} IN ('pending', 'approved', 'completing', 'completed', 'denying', 'denied', 'expired')`,
    ),
    check("agent_authorization_requests_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
        "agent_authorization_requests_decision",
        sql`(
            ${table.status} = 'pending'
            AND ${table.encryptedRequest} IS NOT NULL
            AND ${table.decidedAt} IS NULL
            AND ${table.decidedByUserId} IS NULL
            AND ${table.grantId} IS NULL
            AND ${table.completionClaimHash} IS NULL
            AND ${table.completionClaimExpiresAt} IS NULL
            AND ${table.completedAt} IS NULL
        ) OR (
            ${table.status} = 'approved'
            AND ${table.encryptedRequest} IS NOT NULL
            AND ${table.decidedAt} IS NOT NULL
            AND ${table.decidedByUserId} IS NOT NULL
            AND ${table.grantId} IS NOT NULL
            AND ${table.completionClaimHash} IS NULL
            AND ${table.completionClaimExpiresAt} IS NULL
            AND ${table.completedAt} IS NULL
        ) OR (
            ${table.status} = 'completing'
            AND ${table.encryptedRequest} IS NOT NULL
            AND ${table.decidedAt} IS NOT NULL
            AND ${table.decidedByUserId} IS NOT NULL
            AND ${table.grantId} IS NOT NULL
            AND ${table.completionClaimHash} IS NOT NULL
            AND length(${table.completionClaimHash}) = 64
            AND ${table.completionClaimExpiresAt} IS NOT NULL
            AND ${table.completionClaimExpiresAt} > ${table.updatedAt}
            AND ${table.completedAt} IS NULL
        ) OR (
            ${table.status} = 'completed'
            AND ${table.encryptedRequest} IS NULL
            AND ${table.decidedAt} IS NOT NULL
            AND ${table.decidedByUserId} IS NOT NULL
            AND ${table.grantId} IS NOT NULL
            AND ${table.completionClaimHash} IS NULL
            AND ${table.completionClaimExpiresAt} IS NULL
            AND ${table.completedAt} IS NOT NULL
            AND ${table.completedAt} >= ${table.decidedAt}
        ) OR (
            ${table.status} = 'denying'
            AND ${table.encryptedRequest} IS NOT NULL
            AND ${table.decidedAt} IS NOT NULL
            AND ${table.decidedByUserId} IS NOT NULL
            AND ${table.grantId} IS NULL
            AND ${table.completedAt} IS NULL
            AND (
                (
                    ${table.completionClaimHash} IS NULL
                    AND ${table.completionClaimExpiresAt} IS NULL
                ) OR (
                    ${table.completionClaimHash} IS NOT NULL
                    AND length(${table.completionClaimHash}) = 64
                    AND ${table.completionClaimExpiresAt} IS NOT NULL
                    AND ${table.completionClaimExpiresAt} > ${table.updatedAt}
                )
            )
        ) OR (
            ${table.status} = 'denied'
            AND ${table.encryptedRequest} IS NULL
            AND ${table.decidedAt} IS NOT NULL
            AND ${table.decidedByUserId} IS NOT NULL
            AND ${table.grantId} IS NULL
            AND ${table.completionClaimHash} IS NULL
            AND ${table.completionClaimExpiresAt} IS NULL
            AND ${table.completedAt} IS NOT NULL
            AND ${table.completedAt} >= ${table.decidedAt}
        ) OR (
            ${table.status} = 'expired'
            AND ${table.encryptedRequest} IS NULL
            AND ${table.decidedAt} IS NOT NULL
            AND ${table.grantId} IS NULL
            AND ${table.completionClaimHash} IS NULL
            AND ${table.completionClaimExpiresAt} IS NULL
            AND ${table.completedAt} IS NULL
        )`,
    ),
]);

export const agentDeviceAuthorizations = sqliteTable("agent_device_authorizations", {
    id: text("id").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull(),
    userCodeHmac: text("user_code_hmac").notNull(),
    requestedResource: text("requested_resource", { enum: ["dashboard", "storefront"] }).notNull(),
    requestedPreset: text("requested_preset", {
        enum: ["read", "operator", "full", "custom"],
    }).notNull(),
    clientName: text("client_name"),
    profileName: text("profile_name"),
    requestedPermissionsJson: text("requested_permissions_json").notNull().default("[]"),
    status: text("status", {
        enum: ["pending", "approved", "denied", "expired", "consumed"],
    }).notNull().default("pending"),
    pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(5),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp" }),
    approvedByUserId: text("approved_by_user_id")
        .references(() => user.id, { onDelete: "set null" }),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    grantId: text("grant_id")
        .references(() => agentGrants.id, { onDelete: "set null" }),
    credentialId: text("credential_id")
        .references(() => agentCredentials.id, { onDelete: "set null" }),
    encryptedDeliveryEnvelope: text("encrypted_delivery_envelope"),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    uniqueIndex("agent_device_authorizations_device_code_uq").on(table.deviceCodeHash),
    uniqueIndex("agent_device_authorizations_user_code_uq").on(table.userCodeHmac),
    index("agent_device_authorizations_status_expiry_idx")
        .on(table.status, table.expiresAt),
    index("agent_device_authorizations_grant_idx").on(table.grantId),
    index("agent_device_authorizations_credential_idx").on(table.credentialId),
    check("agent_device_authorizations_id_shape", agentIdCheck(table.id, "ada_")),
    check("agent_device_authorizations_device_hash", sql`length(${table.deviceCodeHash}) = 64`),
    check("agent_device_authorizations_user_hmac", sql`length(${table.userCodeHmac}) = 64`),
    check(
        "agent_device_authorizations_resource",
        sql`${table.requestedResource} IN ('dashboard', 'storefront')`,
    ),
    check(
        "agent_device_authorizations_preset",
        sql`${table.requestedPreset} IN ('read', 'operator', 'full', 'custom')`,
    ),
    check(
        "agent_device_authorizations_client_name",
        sql`${table.clientName} IS NULL OR length(trim(${table.clientName})) BETWEEN 1 AND 80`,
    ),
    check(
        "agent_device_authorizations_profile_name",
        sql`${table.profileName} IS NULL OR length(trim(${table.profileName})) BETWEEN 1 AND 80`,
    ),
    check(
        "agent_device_authorizations_permissions_json",
        sql`${jsonArrayCheck(table.requestedPermissionsJson)} AND length(${table.requestedPermissionsJson}) BETWEEN 2 AND 65536`,
    ),
    check(
        "agent_device_authorizations_status",
        sql`${table.status} IN ('pending', 'approved', 'denied', 'expired', 'consumed')`,
    ),
    check(
        "agent_device_authorizations_poll_interval",
        sql`${table.pollIntervalSeconds} BETWEEN 1 AND 60`,
    ),
    check("agent_device_authorizations_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
        "agent_device_authorizations_state",
        sql`(
            ${table.status} = 'pending'
            AND ${table.decidedAt} IS NULL
            AND ${table.grantId} IS NULL
            AND ${table.credentialId} IS NULL
            AND ${table.encryptedDeliveryEnvelope} IS NULL
            AND ${table.acknowledgedAt} IS NULL
        ) OR (
            ${table.status} = 'approved'
            AND ${table.decidedAt} IS NOT NULL
            AND ${table.approvedByUserId} IS NOT NULL
            AND ${table.grantId} IS NOT NULL
            AND ${table.credentialId} IS NOT NULL
            AND ${table.encryptedDeliveryEnvelope} IS NOT NULL
            AND ${table.acknowledgedAt} IS NULL
        ) OR (
            ${table.status} = 'consumed'
            AND ${table.decidedAt} IS NOT NULL
            AND ${table.approvedByUserId} IS NOT NULL
            AND ${table.grantId} IS NOT NULL
            AND ${table.credentialId} IS NOT NULL
            AND ${table.encryptedDeliveryEnvelope} IS NULL
            AND ${table.acknowledgedAt} IS NOT NULL
        ) OR (
            ${table.status} IN ('denied', 'expired')
            AND ${table.grantId} IS NULL
            AND ${table.credentialId} IS NULL
            AND ${table.encryptedDeliveryEnvelope} IS NULL
            AND ${table.acknowledgedAt} IS NULL
        )`,
    ),
]);

export const agentAuditEvents = sqliteTable("agent_audit_events", {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
        .references(() => agentGrants.id, { onDelete: "set null" }),
    credentialId: text("credential_id")
        .references(() => agentCredentials.id, { onDelete: "set null" }),
    ownerUserId: text("owner_user_id")
        .references(() => user.id, { onDelete: "set null" }),
    resource: text("resource", { enum: ["dashboard", "storefront"] }),
    operationId: text("operation_id").notNull(),
    risk: text("risk", {
        enum: ["read", "write", "destructive", "financial", "security"],
    }).notNull(),
    outcome: text("outcome", { enum: ["success", "denied", "failed"] }).notNull(),
    httpStatus: integer("http_status"),
    errorClass: text("error_class"),
    durationMs: integer("duration_ms"),
    requestId: text("request_id"),
    idempotencyKeyHashPrefix: text("idempotency_key_hash_prefix"),
    resourceIdsJson: text("resource_ids_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("agent_audit_events_grant_created_idx").on(table.grantId, table.createdAt),
    index("agent_audit_events_credential_created_idx")
        .on(table.credentialId, table.createdAt),
    index("agent_audit_events_owner_created_idx").on(table.ownerUserId, table.createdAt),
    index("agent_audit_events_operation_created_idx").on(table.operationId, table.createdAt),
    index("agent_audit_events_outcome_created_idx").on(table.outcome, table.createdAt),
    index("agent_audit_events_created_idx").on(table.createdAt),
    check("agent_audit_events_id_shape", agentIdCheck(table.id, "aae_")),
    check(
        "agent_audit_events_resource",
        sql`${table.resource} IS NULL OR ${table.resource} IN ('dashboard', 'storefront')`,
    ),
    check(
        "agent_audit_events_operation_id",
        sql`length(${table.operationId}) BETWEEN 1 AND 160`,
    ),
    check(
        "agent_audit_events_risk",
        sql`${table.risk} IN ('read', 'write', 'destructive', 'financial', 'security')`,
    ),
    check("agent_audit_events_outcome", sql`${table.outcome} IN ('success', 'denied', 'failed')`),
    check(
        "agent_audit_events_http_status",
        sql`${table.httpStatus} IS NULL OR ${table.httpStatus} BETWEEN 100 AND 599`,
    ),
    check(
        "agent_audit_events_duration",
        sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`,
    ),
    check(
        "agent_audit_events_idempotency_prefix",
        sql`${table.idempotencyKeyHashPrefix} IS NULL OR length(${table.idempotencyKeyHashPrefix}) BETWEEN 8 AND 24`,
    ),
    check(
        "agent_audit_events_resource_ids_json",
        sql`${jsonArrayCheck(table.resourceIdsJson)} AND length(${table.resourceIdsJson}) BETWEEN 2 AND 4096`,
    ),
    check(
        "agent_audit_events_metadata_json",
        sql`${jsonObjectCheck(table.metadataJson)} AND length(${table.metadataJson}) BETWEEN 2 AND 8192`,
    ),
]);

export const agentStorefrontContexts = sqliteTable("agent_storefront_contexts", {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
        .notNull()
        .references(() => agentGrants.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["active", "closed", "expired", "revoked"] })
        .notNull()
        .default("active"),
    revision: integer("revision").notNull().default(1),
    cartJson: text("cart_json").notNull().default("[]"),
    discountCode: text("discount_code"),
    cityId: text("city_id"),
    zoneId: text("zone_id"),
    areaId: text("area_id"),
    shippingMethodId: text("shipping_method_id"),
    customerSessionTokenHash: text("customer_session_token_hash")
        .references(() => customerSessions.tokenHash, { onDelete: "set null" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    closedAt: integer("closed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("agent_storefront_contexts_grant_status_idx").on(table.grantId, table.status),
    index("agent_storefront_contexts_status_expiry_idx").on(table.status, table.expiresAt),
    index("agent_storefront_contexts_customer_session_idx")
        .on(table.customerSessionTokenHash),
    index("agent_storefront_contexts_last_used_idx").on(table.lastUsedAt),
    check("agent_storefront_contexts_id_shape", agentIdCheck(table.id, "asc_")),
    check(
        "agent_storefront_contexts_status",
        sql`${table.status} IN ('active', 'closed', 'expired', 'revoked')`,
    ),
    check("agent_storefront_contexts_revision", sql`${table.revision} >= 1`),
    check(
        "agent_storefront_contexts_cart_json",
        sql`${jsonArrayCheck(table.cartJson)} AND json_array_length(${table.cartJson}) BETWEEN 0 AND 99 AND length(${table.cartJson}) BETWEEN 2 AND 65536`,
    ),
    check("agent_storefront_contexts_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
        "agent_storefront_contexts_close_state",
        sql`(
            ${table.status} = 'active' AND ${table.closedAt} IS NULL
        ) OR (
            ${table.status} <> 'active' AND ${table.closedAt} IS NOT NULL
        )`,
    ),
]);

export const agentStorefrontOrderGrants = sqliteTable("agent_storefront_order_grants", {
    contextId: text("context_id")
        .notNull()
        .references(() => agentStorefrontContexts.id, { onDelete: "cascade" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "cascade" }),
    authorityKind: text("authority_kind", { enum: ["created", "recovered", "customer"] })
        .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    primaryKey({
        name: "agent_storefront_order_grants_pk",
        columns: [table.contextId, table.orderId],
    }),
    index("agent_storefront_order_grants_order_expiry_idx").on(table.orderId, table.expiresAt),
    index("agent_storefront_order_grants_expiry_idx").on(table.expiresAt),
    check(
        "agent_storefront_order_grants_authority_kind",
        sql`${table.authorityKind} IN ('created', 'recovered', 'customer')`,
    ),
    check("agent_storefront_order_grants_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const agentStorefrontContinuations = sqliteTable("agent_storefront_continuations", {
    id: text("id").primaryKey(),
    contextId: text("context_id")
        .notNull()
        .references(() => agentStorefrontContexts.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["customer_auth", "payment", "payment_recovery"] })
        .notNull(),
    orderId: text("order_id")
        .references(() => orders.id, { onDelete: "set null" }),
    paymentAttemptId: text("payment_attempt_id")
        .references(() => paymentSessionAttempts.id, { onDelete: "set null" }),
    status: text("status", { enum: ["pending", "complete", "expired", "failed"] })
        .notNull()
        .default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    bootstrapCodeHash: text("bootstrap_code_hash"),
    bootstrapClaimedAt: integer("bootstrap_claimed_at", { mode: "timestamp" }),
    safeResultJson: text("safe_result_json"),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(UNIX_NOW),
}, (table) => [
    index("agent_storefront_continuations_context_status_idx")
        .on(table.contextId, table.status),
    index("agent_storefront_continuations_status_expiry_idx")
        .on(table.status, table.expiresAt),
    index("agent_storefront_continuations_order_idx").on(table.orderId),
    index("agent_storefront_continuations_payment_attempt_idx")
        .on(table.paymentAttemptId),
    check("agent_storefront_continuations_id_shape", agentIdCheck(table.id, "acn_")),
    check(
        "agent_storefront_continuations_kind",
        sql`${table.kind} IN ('customer_auth', 'payment', 'payment_recovery')`,
    ),
    check(
        "agent_storefront_continuations_status",
        sql`${table.status} IN ('pending', 'complete', 'expired', 'failed')`,
    ),
    check("agent_storefront_continuations_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
        "agent_storefront_continuations_bootstrap_hash",
        sql`${table.bootstrapCodeHash} IS NULL OR (
            length(${table.bootstrapCodeHash}) = 64
            AND ${table.bootstrapCodeHash} NOT GLOB '*[^0-9a-f]*'
        )`,
    ),
    check(
        "agent_storefront_continuations_bootstrap_claim_time",
        sql`${table.bootstrapClaimedAt} IS NULL OR (
            ${table.bootstrapClaimedAt} >= ${table.createdAt}
            AND ${table.bootstrapClaimedAt} <= ${table.expiresAt}
        )`,
    ),
    check(
        "agent_storefront_continuations_bootstrap_state",
        sql`(
            ${table.status} = 'pending'
            AND (
                (${table.bootstrapCodeHash} IS NOT NULL AND ${table.bootstrapClaimedAt} IS NULL)
                OR (${table.bootstrapCodeHash} IS NULL AND ${table.bootstrapClaimedAt} IS NOT NULL)
            )
        ) OR (
            ${table.status} <> 'pending'
            AND ${table.bootstrapCodeHash} IS NULL
        )`,
    ),
    check(
        "agent_storefront_continuations_result_json",
        sql`${table.safeResultJson} IS NULL OR (${jsonObjectCheck(table.safeResultJson)} AND length(${table.safeResultJson}) BETWEEN 2 AND 8192)`,
    ),
    check(
        "agent_storefront_continuations_completion_state",
        sql`(
            ${table.status} = 'pending'
            AND ${table.completedAt} IS NULL
            AND ${table.safeResultJson} IS NULL
        ) OR (
            ${table.status} <> 'pending'
            AND ${table.completedAt} IS NOT NULL
        )`,
    ),
]);

export type AgentGrant = InferSelectModel<typeof agentGrants>;
export type AgentCredential = InferSelectModel<typeof agentCredentials>;
export type AgentArtifactHandle = InferSelectModel<typeof agentArtifactHandles>;
export type AgentBrowserHandoff = InferSelectModel<typeof agentBrowserHandoffs>;
export type AgentAuthorizationRequest = InferSelectModel<typeof agentAuthorizationRequests>;
export type AgentDeviceAuthorization = InferSelectModel<typeof agentDeviceAuthorizations>;
export type AgentAuditEvent = InferSelectModel<typeof agentAuditEvents>;
export type AgentStorefrontContext = InferSelectModel<typeof agentStorefrontContexts>;
export type AgentStorefrontOrderGrant = InferSelectModel<typeof agentStorefrontOrderGrants>;
export type AgentStorefrontContinuation = InferSelectModel<typeof agentStorefrontContinuations>;
