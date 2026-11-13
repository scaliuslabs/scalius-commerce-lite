/**
 * Whether the API's refusal of a read by one URL identifier (a product,
 * category, brand or page handle, a collection or product id) means the
 * address names nothing: a 404, or a 400/422 whose every validation issue is
 * on the identifier itself (too short, too long, characters a handle never
 * has). Such an address can never name anything, so its page is the 404 page.
 *
 * Every other failure (a 5xx, a 429, a timeout, a refusal of a query
 * parameter) is the API not answering: the page says "try again shortly"
 * (503), never a 404 a cache could keep.
 */
export function isIdentifierNotFound(
  status: number | undefined,
  body: unknown,
  identifierFields: readonly string[],
): boolean {
  if (status === 404) return true;
  if (status !== 400 && status !== 422) return false;
  const issues = validationIssues(body);
  return issues.length > 0 && issues.every((issue) => identifierFields.includes(String(issue.path?.[0] ?? "")));
}

interface ValidationIssue {
  path?: ReadonlyArray<string | number>;
}

function validationIssues(body: unknown): ValidationIssue[] {
  const root = body as { error?: { code?: unknown; details?: { issues?: unknown } } } | null;
  const error = root && typeof root === "object" ? root.error : null;
  if (!error || error.code !== "validation_error") return [];
  const issues = error.details?.issues;
  return Array.isArray(issues) ? issues.filter((issue): issue is ValidationIssue => !!issue && typeof issue === "object") : [];
}

/** The body of a refused `apiFetch` read, for `isIdentifierNotFound`; null when it is not JSON. */
export async function refusalBody(response: Response): Promise<unknown> {
  if (response.status !== 400 && response.status !== 422) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}
