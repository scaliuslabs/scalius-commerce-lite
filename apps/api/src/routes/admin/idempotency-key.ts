import type { Context } from "hono";
import { ValidationError } from "../../utils/api-error";
import { scopedRequestKey } from "./idempotency";

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
    if (bodyKey) return bodyKey;
    if (!headerKey) throw new ValidationError(`Idempotency-Key header or body.${bodyField} is required.`);
    return scopedRequestKey(c, operationId, headerKey);
}

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
