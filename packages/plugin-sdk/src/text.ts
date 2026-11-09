/**
 * Your words in a reader's language: `texts[language]`, else its base
 * language (`pt-BR` → `pt`), else English. In a checkout function or a
 * storefront extension pass `input.language` (the buyer's); on an admin
 * screen `adminContext(request).locale` (the staff member's).
 *
 *   title: textFor(input.language, { en: "Gift wrap", bn: "গিফট র‍্যাপ" })
 */
export function textFor<T>(language: string | null | undefined, texts: { readonly en: T } & Readonly<Record<string, T>>): T {
  if (language) {
    const wanted = language.toLowerCase();
    for (const tag of [wanted, wanted.split("-")[0]!]) {
      const match = Object.keys(texts).find((key) => key.toLowerCase() === tag);
      if (match !== undefined) return texts[match]!;
    }
  }
  return texts.en;
}
