// A delivery message on an order line (rules/orders/buyer-line-delivery-message.md):
// what staff write for the buyer of one line (an account's sign-in, an
// instruction) and an optional https link (a tutorial, a private sign-in
// page). Both are as secret as a licence key: encrypted together at rest and
// shown only to the order's signed-in buyer. Pure and dependency-free, so the
// dashboard checks a draft the same way the API does.

/** Characters (Unicode code points) the text may hold. */
export const ORDER_LINE_MESSAGE_TEXT_MAX = 4000;
/** Characters the link may hold once normalized. */
export const ORDER_LINE_MESSAGE_LINK_MAX = 2048;
/**
 * The longest stored ciphertext (`order_line_messages.body_ciphertext`): the
 * sealed `{"text","link"}` JSON at its limits (4,000 four-byte characters and
 * a 2,048-character ASCII link) is 18,086 bytes, 24,136 characters once
 * encoded. The table's CHECK holds this bound.
 */
export const ORDER_LINE_MESSAGE_CIPHERTEXT_MAX = 24576;

/** What a message carries, nothing else. */
export interface OrderLineMessageBody {
    text: string;
    link: string | null;
}

/** Why a draft is refused (`details.reason` of the API's 400). */
export type OrderLineMessageRefusal =
    | "message_text_required"
    | "message_text_too_long"
    | "message_text_control_characters"
    | "message_link_not_https"
    | "message_link_too_long";

function codePoints(value: string): number {
    let count = 0;
    for (const _ of value) count += 1;
    return count;
}

/** Any C0/C1 control character other than a tab or a line break, or a lone surrogate (a pair is one code point under `u`). */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF]/u;

/**
 * The text as stored: line breaks as `\n` and line breaks at either end
 * dropped; every other character kept as written (a password may end in a
 * space). Never HTML: every surface draws it as text.
 */
export function normalizeOrderLineMessageText(value: string): string {
    return value.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * The link as stored: an absolute `https:` URL with a host and no user name
 * or password in it (`https://user@evil.example` reads as another site), or
 * null when it is not one.
 */
export function normalizeOrderLineMessageLink(value: string): string | null {
    const raw = value.trim();
    // eslint-disable-next-line no-control-regex
    if (!raw || /[\u0000-\u001F\u007F\s]/u.test(raw)) return null;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.href;
}

/** A draft checked and normalized, or the first reason it is refused. */
export function readOrderLineMessageDraft(
    input: { text: string; link?: string | null },
): { ok: true; body: OrderLineMessageBody } | { ok: false; reason: OrderLineMessageRefusal; field: "text" | "link" } {
    const text = normalizeOrderLineMessageText(input.text);
    if (!text.trim()) return { ok: false, reason: "message_text_required", field: "text" };
    if (FORBIDDEN_TEXT.test(text)) return { ok: false, reason: "message_text_control_characters", field: "text" };
    if (codePoints(text) > ORDER_LINE_MESSAGE_TEXT_MAX) return { ok: false, reason: "message_text_too_long", field: "text" };
    const rawLink = input.link?.trim() ?? "";
    if (!rawLink) return { ok: true, body: { text, link: null } };
    const link = normalizeOrderLineMessageLink(rawLink);
    if (!link) return { ok: false, reason: "message_link_not_https", field: "link" };
    if (link.length > ORDER_LINE_MESSAGE_LINK_MAX) return { ok: false, reason: "message_link_too_long", field: "link" };
    return { ok: true, body: { text, link } };
}

/** The sealed plaintext: one JSON object, so text and link are one ciphertext. */
export function serializeOrderLineMessageBody(body: OrderLineMessageBody): string {
    return JSON.stringify({ text: body.text, link: body.link });
}

/** The opened plaintext, or null when it is not a message body. */
export function parseOrderLineMessageBody(value: string): OrderLineMessageBody | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { text, link } = parsed as Record<string, unknown>;
    if (typeof text !== "string" || (link !== null && typeof link !== "string")) return null;
    return { text, link };
}
