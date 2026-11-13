import { RICH_TEXT_MAX_LENGTH } from "@scalius/shared/html-sanitize";
import { ValidationError } from "../errors";

type RichTextLengths = Record<string, number | null | undefined>;

/**
 * Refuses sanitized rich text longer than a field stores
 * (RICH_TEXT_MAX_LENGTH), unless it is no longer than the value stored now:
 * a longer value saved before the bound saves again unchanged or shorter, so
 * an unrelated edit never fails on it. `fields`: the error's field name →
 * the sanitized value (undefined when not written). `storedLengths` reads the
 * stored lengths under the same names, only when a value is over the bound.
 */
export async function assertRichTextFits(
    fields: Record<string, string | null | undefined>,
    storedLengths?: () => Promise<RichTextLengths> | RichTextLengths,
): Promise<void> {
    const over = Object.entries(fields).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > RICH_TEXT_MAX_LENGTH);
    if (over.length === 0) return;
    const stored = storedLengths ? await storedLengths() : {};
    for (const [field, value] of over) {
        if (value.length <= Number(stored[field] ?? 0)) continue;
        throw new ValidationError(
            `This text is too long to save: formatted text holds at most ${RICH_TEXT_MAX_LENGTH} characters. Shorten it and save again.`,
            { field },
        );
    }
}
