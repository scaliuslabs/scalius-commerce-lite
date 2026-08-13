import { ValidationError } from "../../utils/api-error";

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
