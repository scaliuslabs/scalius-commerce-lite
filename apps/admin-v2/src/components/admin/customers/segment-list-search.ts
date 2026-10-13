/** Search the API's bounded set of saved segments, never their live members. */
export function filterCustomerSegments<T extends { name: string; description?: string | null }>(
  segments: readonly T[],
  term: string,
): T[] {
  const query = term.trim().normalize("NFC").toLocaleLowerCase();
  return segments.filter((segment) => !query || [segment.name, segment.description ?? ""]
    .some((value) => value.normalize("NFC").toLocaleLowerCase().includes(query)));
}
