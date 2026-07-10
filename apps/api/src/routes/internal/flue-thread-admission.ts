import {
  ASSISTANT_SESSION_CREDENTIAL_PREFIX,
  canonicalizeAssistantJson,
  type AssistantSessionView,
} from "@scalius/core/modules/assistant";
import {
  ServiceUnavailableError,
  UnauthorizedError,
} from "@scalius/core/errors";
import {
  createThreadInstanceId,
  type AgentSurface,
  type ThreadIdentity,
} from "@scalius/shared/assistant-thread-identity";

const MINIMUM_SIGNING_KEY_BYTES = 32;
const textEncoder = new TextEncoder();

export const ASSISTANT_FLUE_THREAD_PATTERN =
  /^conv_[A-Za-z0-9_-]{22,64}$/u;

export interface FlueAgentEnvelope extends ThreadIdentity {
  surface: AgentSurface;
  instanceId: string;
  expiresAt: number;
}

function configuredSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() ? value : null;
}

/**
 * Admission has a dedicated key so compromise or rotation of an unrelated
 * credential cannot change Flue tenant/thread routing.
 */
export function requireAssistantThreadSigningKey(env: Env): string {
  const signingKey = configuredSecret(env.ASSISTANT_THREAD_SIGNING_KEY);
  if (
    !signingKey ||
    textEncoder.encode(signingKey).byteLength < MINIMUM_SIGNING_KEY_BYTES
  ) {
    throw new ServiceUnavailableError(
      "Assistant thread admission is unavailable.",
    );
  }

  const unrelatedSecrets = [
    env.ASSISTANT_RATE_LIMIT_HMAC_KEY,
    env.BETTER_AUTH_SECRET,
    env.CREDENTIAL_ENCRYPTION_KEY,
    env.JWT_SECRET,
    env.API_TOKEN,
  ];
  if (unrelatedSecrets.some((value) => configuredSecret(value) === signingKey)) {
    throw new ServiceUnavailableError(
      "Assistant thread admission is unavailable.",
    );
  }
  return signingKey;
}

export async function deriveFlueThreadIdentity(input: {
  surface: AgentSurface;
  deploymentBindingHash: string;
  actorBinding: unknown;
  threadId: string;
  signingKey: string;
}): Promise<ThreadIdentity> {
  const tenantId = `tenant_${await signOpaqueFacts(input.signingKey, {
    version: "flue-tenant:v1",
    deploymentBindingHash: input.deploymentBindingHash,
  })}`;
  const principalId = `principal_${await signOpaqueFacts(input.signingKey, {
    version: "flue-principal:v1",
    surface: input.surface,
    deploymentBindingHash: input.deploymentBindingHash,
    actorBinding: input.actorBinding,
  })}`;
  return { tenantId, principalId, threadId: input.threadId };
}

export async function deriveHiddenAdminAssistantCredential(input: {
  deploymentBindingHash: string;
  actorId: string;
  dashboardSessionHash: string;
  permissionSnapshotHash: string;
  threadId: string;
  signingKey: string;
}): Promise<string> {
  const signature = await signOpaqueFacts(input.signingKey, {
    version: "admin-flue-authority-credential:v1",
    deploymentBindingHash: input.deploymentBindingHash,
    actorId: input.actorId,
    dashboardSessionHash: input.dashboardSessionHash,
    permissionSnapshotHash: input.permissionSnapshotHash,
    threadId: input.threadId,
  });
  return `${ASSISTANT_SESSION_CREDENTIAL_PREFIX}${signature}`;
}

export async function createFlueAgentEnvelope(input: {
  surface: AgentSurface;
  identity: ThreadIdentity;
  signingKey: string;
  expiresAt: number;
}): Promise<FlueAgentEnvelope> {
  return {
    surface: input.surface,
    instanceId: await createThreadInstanceId(
      input.surface,
      input.identity,
      input.signingKey,
    ),
    ...input.identity,
    expiresAt: input.expiresAt,
  };
}

export function assertFlueAdmissionSession(
  session: AssistantSessionView,
  expected: { surface: AgentSurface; threadId: string },
  now = Date.now(),
): void {
  if (
    session.surface !== expected.surface ||
    session.conversationKey !== expected.threadId ||
    session.status !== "active" ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.expiresAt <= now
  ) {
    throw new UnauthorizedError(
      "Assistant session is unavailable or expired.",
    );
  }
}

export function hasCallerSuppliedFlueIdentity(headers: Headers): boolean {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization" ||
      normalized === "proxy-authorization" ||
      normalized === "x-scalius-assistant-session-credential" ||
      normalized === "x-scalius-tenant-id" ||
      normalized === "x-scalius-principal-id" ||
      normalized === "x-scalius-thread-id"
    ) {
      return true;
    }
  }
  return false;
}

async function signOpaqueFacts(
  signingKey: string,
  facts: unknown,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(textEncoder.encode(signingKey)).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonical = canonicalizeAssistantJson(facts, {
    maxBytes: 4 * 1024,
    maxDepth: 6,
    maxNodes: 64,
    maxObjectKeys: 16,
    maxArrayItems: 16,
    maxStringLength: 512,
  });
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    Uint8Array.from(textEncoder.encode(canonical)).buffer,
  ));
  return encodeBase64Url(signature);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
