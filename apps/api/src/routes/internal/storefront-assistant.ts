import { OpenAPIHono } from "@hono/zod-openapi";
import {
  bindAssistantAgentInstance,
  createAssistantSession,
  createAssistantSessionCredential,
  consumeAssistantRateLimit,
  resumeAssistantSession,
  revokeAssistantSession,
} from "@scalius/core/modules/assistant";
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "@scalius/core/errors";
import {
  STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER,
  storefrontChatRateLimitBucketFromIp,
} from "@scalius/shared/storefront-chat-boundary";
import { ok } from "../../utils/api-response";

import {
  STOREFRONT_ASSISTANT_AUDIENCE,
  STOREFRONT_ASSISTANT_COMMAND_MAX_BODY_BYTES,
  STOREFRONT_ASSISTANT_SESSION_TTL_SECONDS,
  clearStorefrontAssistantSessionCookie,
  hasForbiddenStorefrontAssistantAuthorityHeader,
  isExactInternalStorefrontAssistantRequest,
  parseStorefrontAssistantJson,
  readStorefrontAssistantSessionCredential,
  storefrontAssistantSessionBoundSchema,
  storefrontAssistantSessionCreateSchema,
  storefrontAssistantFlueAdmitSchema,
  storefrontAssistantFlueCommandSchema,
  storefrontAssistantSessionCookie,
} from "./storefront-assistant-contract";
import {
  assertCurrentStorefrontAssistantSession,
  resolveStorefrontAssistantDeploymentContext,
  storefrontAssistantSessionMetadata,
} from "./storefront-assistant-context";
import {
  assertFlueAdmissionSession,
  createFlueAgentEnvelope,
  deriveFlueThreadIdentity,
  hasCallerSuppliedFlueIdentity,
  requireAssistantThreadSigningKey,
} from "./flue-thread-admission";
import {
  executeStorefrontFlueCommand,
  failure as flueCommandFailure,
} from "./flue-command-execution";

const RANDOM_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const app = new OpenAPIHono<{ Bindings: Env }>();

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let result = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += RANDOM_ALPHABET[(accumulator >>> bits) & 63];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    result += RANDOM_ALPHABET[(accumulator << (6 - bits)) & 63];
  }
  return result;
}

export function createStorefrontAssistantSubject(): string {
  return `storefront_subject_${randomBase64Url(32)}`;
}

function compactSession(session: {
  status: "active" | "revoked" | "expired";
  expiresAt: number;
  lastSeenAt: number;
}) {
  return {
    status: session.status,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
  } as const;
}

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  if (!isExactInternalStorefrontAssistantRequest(c.req.raw)) {
    return c.json({ success: false, error: "not_found" }, 404);
  }
  if (hasForbiddenStorefrontAssistantAuthorityHeader(c.req.raw.headers)) {
    throw new ValidationError("Storefront assistant authority header is invalid.");
  }
  await next();
});

app.post("/session/create", async (c) => {
  const input = await parseStorefrontAssistantJson(
    c.req.raw,
    storefrontAssistantSessionCreateSchema,
  );
  const rateLimitKey = c.env.ASSISTANT_RATE_LIMIT_HMAC_KEY?.trim();
  if (!rateLimitKey || new TextEncoder().encode(rateLimitKey).byteLength < 32) {
    throw new ServiceUnavailableError(
      "Storefront assistant session limiter is unavailable.",
    );
  }
  const clientBucket = storefrontChatRateLimitBucketFromIp(
    c.req.header(STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER),
  );
  if (!clientBucket) {
    throw new ServiceUnavailableError(
      "Storefront assistant session client identity is unavailable.",
    );
  }
  await consumeAssistantRateLimit(c.get("db"), {
    scope: "storefront.session.create",
    bucket: clientBucket,
    hashKey: rateLimitKey,
    limit: 10,
    windowSeconds: 60 * 60,
  });
  const deployment = await resolveStorefrontAssistantDeploymentContext(c);
  const subject = createStorefrontAssistantSubject();
  const credential = createAssistantSessionCredential();
  const result = await createAssistantSession(c.get("db"), {
    surface: "storefront",
    actorType: "guest",
    actorId: subject,
    conversationKey: input.conversationId,
    credential,
    permissionSnapshotHash: null,
    safeMetadata: storefrontAssistantSessionMetadata(deployment),
    ttlSeconds: STOREFRONT_ASSISTANT_SESSION_TTL_SECONDS,
  });
  assertCurrentStorefrontAssistantSession(result.session, deployment);
  if (
    result.session.actorId !== subject ||
    result.session.conversationKey !== input.conversationId
  ) {
    throw new UnauthorizedError(
      "Storefront assistant session ownership is unavailable.",
    );
  }

  c.header(
    "Set-Cookie",
    storefrontAssistantSessionCookie(credential, result.session.conversationKey),
  );
  return ok(c, {
    subject,
    audience: STOREFRONT_ASSISTANT_AUDIENCE,
    conversationId: result.session.conversationKey,
    session: compactSession(result.session),
    replayed: result.replayed,
  });
});

app.post("/session/resolve", async (c) => {
  const credential = readStorefrontAssistantSessionCredential(c.req.raw);
  const input = await parseStorefrontAssistantJson(
    c.req.raw,
    storefrontAssistantSessionBoundSchema,
  );
  const deployment = await resolveStorefrontAssistantDeploymentContext(c);
  const session = await resumeAssistantSession(c.get("db"), {
    credential,
    expectedSurface: "storefront",
    expectedConversationKey: input.conversationId,
    expectedPermissionSnapshotHash: null,
    expectedSafeMetadata: storefrontAssistantSessionMetadata(deployment),
    touchAfterSeconds: 5 * 60,
  });
  assertCurrentStorefrontAssistantSession(session, deployment);

  return ok(c, {
    subject: session.actorId,
    audience: STOREFRONT_ASSISTANT_AUDIENCE,
    conversationId: session.conversationKey,
    session: compactSession(session),
  });
});

app.post("/session/revoke", async (c) => {
  const credential = readStorefrontAssistantSessionCredential(c.req.raw);
  const input = await parseStorefrontAssistantJson(
    c.req.raw,
    storefrontAssistantSessionBoundSchema,
  );
  const deployment = await resolveStorefrontAssistantDeploymentContext(c);
  const session = await resumeAssistantSession(c.get("db"), {
    credential,
    expectedSurface: "storefront",
    expectedConversationKey: input.conversationId,
    expectedPermissionSnapshotHash: null,
    expectedSafeMetadata: storefrontAssistantSessionMetadata(deployment),
    touchAfterSeconds: 5 * 60,
  });
  assertCurrentStorefrontAssistantSession(session, deployment);
  const revoked = await revokeAssistantSession(c.get("db"), {
    sessionId: session.id,
  });

  c.header(
    "Set-Cookie",
    clearStorefrontAssistantSessionCookie(session.conversationKey),
  );
  return ok(c, {
    revoked: true as const,
    changed: revoked.changed,
    session: compactSession(revoked.session),
  });
});

app.post("/flue/admit", async (c) => {
  if (hasCallerSuppliedFlueIdentity(c.req.raw.headers)) {
    throw new ValidationError("Assistant thread admission header is invalid.");
  }
  const credential = readStorefrontAssistantSessionCredential(c.req.raw);
  const input = await parseStorefrontAssistantJson(
    c.req.raw,
    storefrontAssistantFlueAdmitSchema,
  );
  const signingKey = requireAssistantThreadSigningKey(c.env);
  const deployment = await resolveStorefrontAssistantDeploymentContext(c);
  const session = await resumeAssistantSession(c.get("db"), {
    credential,
    expectedSurface: "storefront",
    expectedConversationKey: input.threadId,
    expectedPermissionSnapshotHash: null,
    expectedSafeMetadata: storefrontAssistantSessionMetadata(deployment),
    touchAfterSeconds: 5 * 60,
  });
  assertCurrentStorefrontAssistantSession(session, deployment);
  assertFlueAdmissionSession(session, {
    surface: "storefront",
    threadId: input.threadId,
  });
  const identity = await deriveFlueThreadIdentity({
    surface: "storefront",
    deploymentBindingHash: deployment.deploymentBindingHash,
    actorBinding: {
      actorId: session.actorId,
      authoritySessionId: session.id,
    },
    threadId: input.threadId,
    signingKey,
  });
  const agent = await createFlueAgentEnvelope({
    surface: "storefront",
    identity,
    signingKey,
    expiresAt: session.expiresAt,
  });
  const bound = await bindAssistantAgentInstance(c.get("db"), {
    sessionId: session.id,
    agentInstanceId: agent.instanceId,
  });
  assertCurrentStorefrontAssistantSession(bound, deployment);
  assertFlueAdmissionSession(bound, {
    surface: "storefront",
    threadId: input.threadId,
  });

  return ok(c, {
    agent: { ...agent, expiresAt: bound.expiresAt },
  });
});

app.post("/flue/command", async (c) => {
  if (hasCallerSuppliedFlueIdentity(c.req.raw.headers)) {
    return c.json(flueCommandFailure(
      "invalid_request",
      "Scalius request headers are invalid.",
      false,
    ), 400);
  }
  try {
    const input = await parseStorefrontAssistantJson(
      c.req.raw,
      storefrontAssistantFlueCommandSchema,
      STOREFRONT_ASSISTANT_COMMAND_MAX_BODY_BYTES,
    );
    const response = await executeStorefrontFlueCommand(c, input);
    return c.json(response, response.success ? 200 : 400);
  } catch (error) {
    const [status, code, message, retryable] = storefrontCommandError(error);
    return c.json(flueCommandFailure(code, message, retryable), status);
  }
});

app.all("*", (c) => c.json({ success: false, error: "not_found" }, 404));

export { app as storefrontAssistantAuthorityRoutes };

function storefrontCommandError(
  error: unknown,
): [400 | 401 | 403 | 404 | 503, string, string, boolean] {
  if (error instanceof UnauthorizedError) {
    return [401, "access_unavailable", "Assistant access is unavailable.", false];
  }
  if (error instanceof ForbiddenError) {
    return [403, "capability_forbidden", "That capability is not available.", false];
  }
  if (error instanceof NotFoundError) {
    return [404, "capability_not_found", "That capability is not available.", false];
  }
  if (error instanceof ValidationError) {
    return [400, "invalid_arguments", "Capability arguments are invalid.", false];
  }
  return [503, "scalius_unavailable", "Scalius is temporarily unavailable.", true];
}
