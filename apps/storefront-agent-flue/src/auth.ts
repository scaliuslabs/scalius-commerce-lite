import type { AgentSurface, ThreadIdentity } from "./thread-identity";
import { verifyThreadInstanceId } from "./thread-identity";

const MINIMUM_SECRET_LENGTH = 32;
const MAXIMUM_SERVICE_TOKEN_LENGTH = 512;
const textEncoder = new TextEncoder();

export interface CanaryAuthEnv {
  CANARY_AUTH_TOKEN: string;
  THREAD_ID_SIGNING_KEY: string;
  COMPUTER_TICKET_SIGNING_KEY: string;
}

export type AuthorizationResult =
  | { authorized: true; identity: ThreadIdentity }
  | {
      authorized: false;
      reason:
        | "route_invalid"
        | "configuration_unavailable"
        | "service_token_invalid"
        | "thread_identity_invalid";
    };

export function isStorefrontAgentAuthConfigured(
  env: CanaryAuthEnv | undefined,
): env is CanaryAuthEnv {
  return Boolean(
    env?.CANARY_AUTH_TOKEN &&
      env.THREAD_ID_SIGNING_KEY &&
      env.COMPUTER_TICKET_SIGNING_KEY &&
      textEncoder.encode(env.CANARY_AUTH_TOKEN).byteLength >=
        MINIMUM_SECRET_LENGTH &&
      env.CANARY_AUTH_TOKEN.length <= MAXIMUM_SERVICE_TOKEN_LENGTH &&
      textEncoder.encode(env.THREAD_ID_SIGNING_KEY).byteLength >=
        MINIMUM_SECRET_LENGTH &&
      textEncoder.encode(env.COMPUTER_TICKET_SIGNING_KEY).byteLength >=
        MINIMUM_SECRET_LENGTH,
  );
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(value)),
  );
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  if (left.length > 512 || right.length > 512) return false;
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = left.length ^ right.length;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
}

function parseAgentPath(request: Request, expectedAgentName: string): string | null {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  if (
    segments[0] !== "agents" ||
    segments[1] !== expectedAgentName ||
    (segments.length !== 3 && !(segments.length === 4 && segments[3] === "abort"))
  ) {
    return null;
  }
  try {
    return decodeURIComponent(segments[2] ?? "");
  } catch {
    return null;
  }
}

export async function authorizeAgentRequest(
  request: Request,
  env: CanaryAuthEnv | undefined,
  expectedAgentName: string,
  surface: AgentSurface,
): Promise<AuthorizationResult> {
  const instanceId = parseAgentPath(request, expectedAgentName);
  if (!instanceId) return { authorized: false, reason: "route_invalid" };
  return authorizeThreadInstanceRequest(request, env, surface, instanceId);
}

export async function authorizeThreadInstanceRequest(
  request: Request,
  env: CanaryAuthEnv | undefined,
  surface: AgentSurface,
  instanceId: string,
): Promise<AuthorizationResult> {
  if (!isStorefrontAgentAuthConfigured(env)) {
    return { authorized: false, reason: "configuration_unavailable" };
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return { authorized: false, reason: "service_token_invalid" };
  }
  const presentedToken = authorization.slice("Bearer ".length);
  if (!presentedToken || !(await secureEqual(presentedToken, env.CANARY_AUTH_TOKEN))) {
    return { authorized: false, reason: "service_token_invalid" };
  }

  const identity = {
    tenantId: request.headers.get("x-scalius-tenant-id") ?? "",
    principalId: request.headers.get("x-scalius-principal-id") ?? "",
    threadId: request.headers.get("x-scalius-thread-id") ?? "",
  };
  if (!(await verifyThreadInstanceId(instanceId, surface, identity, env.THREAD_ID_SIGNING_KEY))) {
    return { authorized: false, reason: "thread_identity_invalid" };
  }
  return { authorized: true, identity };
}
