import { getLocale } from "~/i18n";

/** A country's name in `locale` (`Intl.DisplayNames`), else its code. */
export function countryNameIn(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale === "bn" ? "bn" : "en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A country's name in the dashboard language, else its code. */
export function countryName(code: string): string {
  return countryNameIn(code, getLocale());
}
