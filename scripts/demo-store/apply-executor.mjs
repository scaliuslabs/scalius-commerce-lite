import { ApplyHttpError } from "./apply-client.mjs";

function safeAuthority(resource) {
  if (!resource || typeof resource !== "object") return null;
  const authority = Object.fromEntries([
    "id", "aggregateRevision", "revision", "version", "defaultVariantId",
  ].filter((field) => resource[field] !== undefined).map((field) => [field, resource[field]]));
  if (!authority.defaultVariantId) {
    const defaults = (resource.variants ?? []).filter((variant) => variant.isDefault === true && !variant.deletedAt);
    if (defaults.length === 1) authority.defaultVariantId = defaults[0].id;
  }
  return authority;
}

export async function executeIdempotentCommand(command, {
  client,
  resolveCurrent,
  matchesDesired,
}) {
  const before = await resolveCurrent(command);
  if (before && await matchesDesired(command, before)) {
    return { logicalKey: command.logicalKey, status: "already_applied", resourceId: before.id ?? null, authority: safeAuthority(before) };
  }
  if (command.action === "create" && before) {
    return { logicalKey: command.logicalKey, status: "conflict", resourceId: before.id ?? null, code: "IDENTITY_ALREADY_EXISTS" };
  }
  let effectiveCommand = command;
  if (command.action === "update") {
    if (!before) return { logicalKey: command.logicalKey, status: "conflict", resourceId: null, code: "RESOURCE_MISSING" };
    const currentRevision = before.aggregateRevision ?? before.revision ?? before.version;
    if (command.expectedRevision === "REFETCH_AFTER_BASE") {
      effectiveCommand = {
        ...command,
        expectedRevision: currentRevision,
        body: { ...command.body, expectedAggregateRevision: currentRevision },
      };
    } else if (currentRevision !== command.expectedRevision) {
      return { logicalKey: command.logicalKey, status: "conflict", resourceId: before.id ?? null, code: "STALE_REVISION" };
    }
  }
  try {
    await client.send(effectiveCommand);
  } catch (error) {
    const afterFailure = await resolveCurrent(command);
    if (afterFailure && await matchesDesired(command, afterFailure)) {
      return { logicalKey: command.logicalKey, status: "adopted_after_ambiguous_response", resourceId: afterFailure.id ?? null, authority: safeAuthority(afterFailure) };
    }
    if (error instanceof ApplyHttpError && error.status === 409) {
      return { logicalKey: command.logicalKey, status: "conflict", resourceId: afterFailure?.id ?? null, code: error.code ?? "REVISION_CONFLICT" };
    }
    throw error;
  }
  const after = await resolveCurrent(command);
  if (!after || !await matchesDesired(command, after)) throw new Error(`Command ${command.logicalKey} returned success but verification disagreed.`);
  return { logicalKey: command.logicalKey, status: "applied", resourceId: after.id ?? null, authority: safeAuthority(after) };
}

export async function executeApplyPhase(commands, dependencies) {
  const outcomes = [];
  for (const command of commands) {
    const outcome = await executeIdempotentCommand(command, dependencies);
    outcomes.push(outcome);
    if (outcome.status === "conflict") break;
  }
  return {
    outcomes,
    ok: outcomes.every((outcome) => outcome.status !== "conflict"),
  };
}
