import { ValidationError } from "../../errors";

const DISCOUNT_MAX_USES_TRIGGER_CODE = "DISCOUNT_MAX_USES_EXCEEDED";
const DISCOUNT_ONE_PER_CUSTOMER_TRIGGER_CODE = "DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED";
const DISCOUNT_CUSTOMER_KEY_REQUIRED_TRIGGER_CODE = "DISCOUNT_CUSTOMER_KEY_REQUIRED";

function collectErrorText(error: unknown, depth = 0): string {
    if (depth > 3 || error === null || error === undefined) return "";

    if (error instanceof Error) {
        const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
        return [
            error.name,
            error.message,
            collectErrorText(cause, depth + 1),
        ].filter(Boolean).join(" ");
    }

    if (typeof error === "object") {
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }

    return String(error);
}

export function getDiscountUsageConstraintError(error: unknown): ValidationError | null {
    const errorText = collectErrorText(error);
    if (errorText.includes(DISCOUNT_MAX_USES_TRIGGER_CODE)) {
        return new ValidationError("Discount code has reached its usage limit");
    }
    if (errorText.includes(DISCOUNT_ONE_PER_CUSTOMER_TRIGGER_CODE)) {
        return new ValidationError("Discount already used by this customer");
    }
    if (errorText.includes(DISCOUNT_CUSTOMER_KEY_REQUIRED_TRIGGER_CODE)) {
        return new ValidationError("A valid phone number is required to use this discount");
    }
    return null;
}
