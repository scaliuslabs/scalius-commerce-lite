import type { AgentSurface, ThreadIdentity } from "./thread-identity";
import { verifyThreadInstanceId } from "./thread-identity";

const MINIMUM_SECRET_LENGTH = 32;

export interface CanaryAuthEnv {
  CANARY_AUTH_TOKEN: string;
  THREAD_ID_SIGNING_KEY: string;
  COMPUTER_TICKET_SIGNING_KEY: string;
}

export type AuthorizationResult =
  | { authorized: true; identity: ThreadIdentity }
  | { authorized: false };

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
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
  if (!instanceId) return { authorized: false };
  return authorizeThreadInstanceRequest(request, env, surface, instanceId);
}

export async function authorizeThreadInstanceRequest(
  request: Request,
  env: CanaryAuthEnv | undefined,
  surface: AgentSurface,
  instanceId: string,
): Promise<AuthorizationResult> {
  if (
    !env?.CANARY_AUTH_TOKEN ||
    !env.THREAD_ID_SIGNING_KEY ||
    env.CANARY_AUTH_TOKEN.length < MINIMUM_SECRET_LENGTH ||
    env.THREAD_ID_SIGNING_KEY.length < MINIMUM_SECRET_LENGTH
  ) {
    return { authorized: false };
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return { authorized: false };
  const presentedToken = authorization.slice("Bearer ".length);
  if (!presentedToken || !(await secureEqual(presentedToken, env.CANARY_AUTH_TOKEN))) {
    return { authorized: false };
  }

  const identity = {
    tenantId: request.headers.get("x-scalius-tenant-id") ?? "",
    principalId: request.headers.get("x-scalius-principal-id") ?? "",
    threadId: request.headers.get("x-scalius-thread-id") ?? "",
  };
  if (!(await verifyThreadInstanceId(instanceId, surface, identity, env.THREAD_ID_SIGNING_KEY))) {
    return { authorized: false };
  }
  return { authorized: true, identity };
}
