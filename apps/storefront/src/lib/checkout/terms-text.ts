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
