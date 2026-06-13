const INLINE_SCRIPT_ESCAPES: Record<string, string> = {
  "<": "\\u003C",
  ">": "\\u003E",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function serializeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => INLINE_SCRIPT_ESCAPES[char] ?? char,
  );
}
