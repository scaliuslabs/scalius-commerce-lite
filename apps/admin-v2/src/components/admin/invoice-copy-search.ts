// The invoice routes' `?copy=staff` search param, apart from the copy toggle
// (invoice-copy-language.tsx): route search validation runs in the entry
// chunk, and the toggle's invoice copy must load with the invoice page.

/** `?copy=staff`: the staff member's copy. */
export type InvoiceCopySearch = { copy?: "staff" };

export function parseInvoiceCopy(search: Record<string, unknown>): InvoiceCopySearch {
  return search.copy === "staff" ? { copy: "staff" } : {};
}
