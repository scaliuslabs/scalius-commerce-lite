export interface TermsLink {
  label: string;
  href: string | null;
}

export interface TermsSegment {
  text: string;
  href: string | null;
}

/**
 * The checkout agreement line split into text and policy links. `{terms}` and
 * `{privacy}` become the linked policy names; copy saved before those tokens
 * existed links the literal names instead. A policy without a published page
 * stays plain text.
 */
export function termsSegments(
  text: string,
  links: { terms: TermsLink; privacy: TermsLink },
): TermsSegment[] {
  const byToken: Record<string, TermsLink> = { "{terms}": links.terms, "{privacy}": links.privacy };
  const pattern = /\{terms\}|\{privacy\}/g.test(text)
    ? /(\{terms\}|\{privacy\})/
    : literalPattern([links.terms.label, links.privacy.label]);
  if (!pattern) return [{ text, href: null }];
  const byLabel = new Map([
    [links.terms.label, links.terms],
    [links.privacy.label, links.privacy],
  ]);
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => {
      const link = byToken[part] ?? byLabel.get(part);
      return link ? { text: link.label, href: link.href } : { text: part, href: null };
    });
}

function literalPattern(labels: string[]): RegExp | null {
  const present = labels.filter(Boolean);
  if (present.length === 0) return null;
  const escaped = present.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(${escaped.join("|")})`);
}

/** The posted name of the "I agree to the terms" box (value `true`). */
export const TERMS_ACCEPTED_FIELD = "termsAccepted";

/**
 * The terms line a checkout draws beside the action that places the order
 * on every checkout form: the merchant's sentence when the store
 * has a published terms page, or, when the store requires agreement, a
 * required box labelled with its own words. Null: nothing to show.
 */
export interface TermsAgreement {
  required: boolean;
  segments: TermsSegment[];
}

export function termsAgreement(input: {
  required: boolean | undefined;
  policies: ReadonlyArray<{ kind: string; path: string }> | null | undefined;
  copy: { termsText: string; termsAcceptText: string; termsLinkText: string; privacyLinkText: string };
}): TermsAgreement | null {
  const path = (kind: string) => input.policies?.find((policy) => policy.kind === kind)?.path ?? null;
  const required = input.required === true;
  if (!required && !path("terms")) return null;
  const links = {
    terms: { label: input.copy.termsLinkText, href: path("terms") },
    privacy: { label: input.copy.privacyLinkText, href: path("privacy") },
  };
  return { required, segments: termsSegments(required ? input.copy.termsAcceptText : input.copy.termsText, links) };
}

/** `termsAccepted: true` for the order when the buyer ticked the box (a form post or the stored checkout). */
export function termsAcceptedOrderField(input: unknown): { termsAccepted?: true } {
  if (!input || typeof input !== "object") return {};
  const value = input instanceof FormData ? input.get(TERMS_ACCEPTED_FIELD) : (input as Record<string, unknown>)[TERMS_ACCEPTED_FIELD];
  return value === true || value === "true" ? { termsAccepted: true } : {};
}

/**
 * Before the order is placed: a required box left unticked is said under it
 * (its alert announces the words) and focused. True when the order may go:
 * no box, a box that is off (`disabled`: not this way of paying), or ticked.
 */
export function checkTermsAgreement(root: ParentNode): boolean {
  const box = root.querySelector<HTMLInputElement>(`input[name="${TERMS_ACCEPTED_FIELD}"]`);
  const note = box ? document.getElementById(`${box.id}-error`) : null;
  const show = (invalid: boolean) => {
    box?.setAttribute("aria-invalid", invalid ? "true" : "false");
    if (note) note.textContent = invalid ? note.dataset.text ?? "" : "";
  };
  if (!box || box.disabled || box.checked) {
    show(false);
    return true;
  }
  show(true);
  box.addEventListener("change", () => show(!box.checked), { once: true });
  box.scrollIntoView?.({ behavior: "smooth", block: "center" });
  box.focus({ preventScroll: true });
  return false;
}
