import type { Context } from "hono";
import { ValidationError } from "../../utils/api-error";
import { scopedRequestKey } from "./idempotency";

// Every retry key a route hands a store is the caller's own: a key sent in the
// body or the Idempotency-Key header is scoped to the principal (an app, an
// agent grant or the staff member) and the operation (`scopedRequestKey`)
// before any store sees it. Two callers sending one key, even on one order or
// document, never share an attempt; one caller's repeat maps to the same key
// and replays. Only the manual-order create and amendment take the key as
// sent, because their core attempt is scoped by the principal itself
// (`buildAdminOrderCreateAttemptIdentity`).

/**
 * The durable request key of an operation that moves money or issues value,
 * which a retry must never repeat: the body key when one is sent (the
 * dashboard, and agents that name it: it wins over a transport key MCP added,
 * so their retry with the same body is still the same request), else the
 * `Idempotency-Key` header (agents, the CLI), scoped to the caller and
 * operation as the app API scopes it. Neither is refused: without a key a lost
 * response's retry would act twice.
 */
export async function requiredRequestKey(
    c: Context,
    operationId: string,
    headerKey: string | undefined,
    bodyKey: string | undefined,
    bodyField: string,
): Promise<string> {
    const key = bodyKey || headerKey;
    if (!key) throw new ValidationError(`Idempotency-Key header or body.${bodyField} is required.`);
    return scopedRequestKey(c, operationId, key);
}

/**
 * The retry key of a command that takes it in the header or the body (they
 * must match when both are sent), scoped to the caller and operation.
 */
export async function principalIdempotencyKey(
    c: Context,
    operationId: string,
    headerKey: string | undefined,
    bodyKey: string | undefined,
    bodyField: string,
): Promise<string> {
    return scopedRequestKey(c, operationId, resolveCanonicalIdempotencyKey(headerKey, bodyKey, bodyField));
}

/** A required body key (a draft's or a scanner's UUID), scoped to the caller and operation. */
export function principalBodyKey(c: Context, operationId: string, bodyKey: string): Promise<string> {
    return scopedRequestKey(c, operationId, bodyKey);
}

/**
 * The header or body key as sent, for a store that scopes it by the principal
 * itself (the manual-order create and amendment); every other store takes
 * `principalIdempotencyKey`.
 */
export function resolveCanonicalIdempotencyKey(
    headerKey: string | undefined,
    bodyKey: string | undefined,
    bodyField: string,
): string {
    if (headerKey && bodyKey && headerKey !== bodyKey) {
        throw new ValidationError(
            `Idempotency-Key header must match body.${bodyField}.`,
        );
    }
    const canonicalKey = headerKey ?? bodyKey;
    if (!canonicalKey) {
        throw new ValidationError(
            `Idempotency-Key header or body.${bodyField} is required.`,
        );
    }
    return canonicalKey;
}
