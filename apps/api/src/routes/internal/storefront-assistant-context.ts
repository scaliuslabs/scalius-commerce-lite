import type { Context } from "hono";
import {
  constantTimeAssistantHashEqual,
  hashAssistantArguments,
  type AssistantSessionView,
} from "@scalius/core/modules/assistant";
import {
  ServiceUnavailableError,
  UnauthorizedError,
} from "@scalius/core/errors";

import {
  STOREFRONT_ASSISTANT_CONVERSATION_PATTERN,
  STOREFRONT_ASSISTANT_SUBJECT_PATTERN,
} from "./storefront-assistant-contract";

const STOREFRONT_SESSION_METADATA_VERSION = 1;

export interface StorefrontAssistantDeploymentContext {
  deploymentBindingHash: string;
}

function requireConfiguredOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ServiceUnavailableError(
      "Storefront assistant deployment binding is unavailable.",
    );
  }
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new ServiceUnavailableError(
      "Storefront assistant deployment binding is unavailable.",
    );
  }
}

export async function resolveStorefrontAssistantDeploymentContext(
  c: Context<{ Bindings: Env }>,
): Promise<StorefrontAssistantDeploymentContext> {
  const storefrontOrigin = requireConfiguredOrigin(c.env.STOREFRONT_URL);
  const apiOrigin = requireConfiguredOrigin(c.env.PUBLIC_API_BASE_URL);
  const environmentMarker = typeof c.env.PROJECT_CACHE_PREFIX === "string"
    ? c.env.PROJECT_CACHE_PREFIX.trim().slice(0, 160)
    : "default";

  return {
    deploymentBindingHash: await hashAssistantArguments({
      version: "storefront-assistant-deployment:v1",
      storefrontOrigin,
      apiOrigin,
      environmentMarker,
    }),
  };
}

export function storefrontAssistantSessionMetadata(
  context: StorefrontAssistantDeploymentContext,
) {
  return {
    schemaVersion: STOREFRONT_SESSION_METADATA_VERSION,
    deploymentBindingHash: context.deploymentBindingHash,
  } as const;
}

export function assertCurrentStorefrontAssistantSession(
  session: AssistantSessionView,
  context: StorefrontAssistantDeploymentContext,
  now = Date.now(),
): asserts session is AssistantSessionView & { actorId: string } {
  if (
    session.surface !== "storefront" ||
    session.actorType !== "guest" ||
    !session.actorId ||
    !STOREFRONT_ASSISTANT_SUBJECT_PATTERN.test(session.actorId) ||
    !STOREFRONT_ASSISTANT_CONVERSATION_PATTERN.test(
      session.conversationKey,
    ) ||
    session.permissionSnapshotHash !== null ||
    session.status !== "active" ||
    session.expiresAt <= now ||
    !hasCurrentDeploymentMetadata(
      session.safeMetadata,
      context.deploymentBindingHash,
    )
  ) {
    throw new UnauthorizedError(
      "Storefront assistant session is unavailable or expired.",
    );
  }
}

function hasCurrentDeploymentMetadata(
  value: unknown,
  expectedHash: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return metadata.schemaVersion === STOREFRONT_SESSION_METADATA_VERSION &&
    typeof metadata.deploymentBindingHash === "string" &&
    constantTimeAssistantHashEqual(
      metadata.deploymentBindingHash,
      expectedHash,
    );
}
