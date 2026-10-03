import { getLocale } from "~/i18n";

/** A country's name in the dashboard language (`Intl.DisplayNames`), else its code. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames([getLocale() === "bn" ? "bn" : "en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
