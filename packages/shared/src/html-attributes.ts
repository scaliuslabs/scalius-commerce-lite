/** Reads one quoted HTML attribute in linear time without executing markup. */
export function readQuotedHtmlAttribute(
  source: string,
  attributeName: string,
): string | null {
  const lowerSource = source.toLowerCase();
  const lowerName = attributeName.toLowerCase();
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const nameStart = lowerSource.indexOf(lowerName, searchFrom);
    if (nameStart < 0) return null;
    searchFrom = nameStart + lowerName.length;

    const before = nameStart === 0 ? " " : source[nameStart - 1];
    if (before && !isHtmlAttributeBoundary(before)) continue;

    let cursor = searchFrom;
    while (isHtmlWhitespace(source[cursor])) cursor += 1;
    if (source[cursor] !== "=") continue;
    cursor += 1;
    while (isHtmlWhitespace(source[cursor])) cursor += 1;

    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") continue;
    const valueStart = cursor + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) return null;
    return source.slice(valueStart, valueEnd);
  }

  return null;
}

function isHtmlAttributeBoundary(character: string): boolean {
  return character === "<" || character === "/" || isHtmlWhitespace(character);
}

function isHtmlWhitespace(character: string | undefined): boolean {
  return character === " "
    || character === "\n"
    || character === "\r"
    || character === "\t"
    || character === "\f";
}
