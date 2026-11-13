import { RICH_TEXT_MAX_LENGTH, sanitizeHtmlField, type SafeHtml } from "@scalius/shared/html-sanitize";
import { richTextSearchText } from "@scalius/shared/search-text";
import { ValidationError } from "../errors";

type RichTextLengths = Record<string, number | null | undefined>;

/**
 * The longest raw rich text a write may send, checked before any parsing:
 * four times what a field stores, room for markup the sanitizer drops, so
 * megabytes of comments or unknown tags are refused without being parsed.
 */
export const RICH_TEXT_MAX_INPUT_LENGTH = 4 * RICH_TEXT_MAX_LENGTH;

const TOO_LONG = `This text is too long to save: formatted text holds at most ${RICH_TEXT_MAX_LENGTH} characters. Shorten it and save again.`;

/**
 * Rich text as a write stores it: each field's sanitized value (`html`) and
 * the search text of that value (`searchText`: `richTextSearchText`, what
 * search indexes in place of the markup; undefined when the field is not
 * written, null when it is cleared). The search text is derived here, from
 * the sanitized value, on first read and once, so a write that stores a
 * searched column reads both from the one sanitize call.
 */
export interface SanitizedRichText<K extends string> {
    html: Record<K, SafeHtml | null | undefined>;
    searchText: Readonly<Record<K, string | null | undefined>>;
}

function withSearchText<K extends string>(html: Record<K, SafeHtml | null | undefined>): SanitizedRichText<K> {
    const searchText = {} as Record<K, string | null | undefined>;
    for (const field of Object.keys(html) as K[]) {
        let text: string | null | undefined;
        let read = false;
        Object.defineProperty(searchText, field, {
            enumerable: true,
            get: () => {
                if (!read) {
                    text = html[field] === undefined ? undefined : richTextSearchText(html[field]);
                    read = true;
                }
                return text;
            },
        });
    }
    return { html, searchText };
}

/**
 * The one way a domain write stores rich text. `fields`: the error's field
 * name → the raw value (undefined: not written; null: cleared). Raw input over
 * RICH_TEXT_MAX_INPUT_LENGTH is refused before any parsing; the rest is
 * sanitized, and a sanitized value longer than a field stores
 * (RICH_TEXT_MAX_LENGTH) is refused unless it is no longer than the value
 * stored now, so a longer value saved before the bound saves again unchanged
 * or shorter and an unrelated edit never fails on it. `storedLengths` reads
 * the stored lengths under the same names, only when a value is over the bound.
 */
export async function sanitizeRichText<K extends string>(
    fields: Record<K, string | null | undefined>,
    storedLengths?: () => Promise<RichTextLengths> | RichTextLengths,
): Promise<SanitizedRichText<K>> {
    const entries = Object.entries(fields) as Array<[K, string | null | undefined]>;
    for (const [field, value] of entries) {
        if (typeof value === "string" && value.length > RICH_TEXT_MAX_INPUT_LENGTH) throw new ValidationError(TOO_LONG, { field });
    }
    const sanitized = Object.fromEntries(entries.map(([field, value]) => [field, sanitizeHtmlField(value)])) as Record<K, SafeHtml | null | undefined>;
    const over = (Object.entries(sanitized) as Array<[K, SafeHtml | null | undefined]>)
        .filter((entry): entry is [K, SafeHtml] => typeof entry[1] === "string" && entry[1].length > RICH_TEXT_MAX_LENGTH);
    if (over.length === 0) return withSearchText(sanitized);
    const stored = storedLengths ? await storedLengths() : {};
    for (const [field, value] of over) {
        if (value.length > Number(stored[field] ?? 0)) throw new ValidationError(TOO_LONG, { field });
    }
    return withSearchText(sanitized);
}
