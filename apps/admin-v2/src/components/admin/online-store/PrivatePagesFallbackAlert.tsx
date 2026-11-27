// The live theme's private pages the store's maintenance compile refused
// after an update (`compiled.refused`, written with the save's own issues):
// each page that now shows the store's own design, why in plain words, the
// store's check word for word, and the fix. Nothing while every page serves
// the theme's design.
import { TriangleAlert } from "lucide-react";
import { privatePagesRefused, type PrivatePageKey, type PrivatePageRefusal, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { useMessages } from "~/i18n";
import { themePrivateFallbackMessages } from "~/i18n/theme-private-fallback";

type Why = "readability" | "prominence" | "style" | "layout" | "words" | "files" | "unavailable" | "size" | "other";

/** Why a page was refused, in the merchant's terms: by where the refused value sits, then its reason. */
export function privateRefusalWhy(refusal: PrivatePageRefusal): Why {
  if (refusal.reason === "not_available") return "unavailable";
  if (refusal.reason === "too_large") return "size";
  if (refusal.reason === "foreign_asset") return "files";
  const [, place] = refusal.path.split(".");
  if (place === "pages") return "layout";
  if (place === "labels") return "words";
  if (place === "tokens") return refusal.reason === "contrast" ? "readability" : refusal.reason === "prominence" ? "prominence" : "style";
  return "other";
}

export function PrivatePagesFallbackAlert({ theme }: { theme: StorefrontThemeDocument }) {
  const t = useMessages(themePrivateFallbackMessages);
  const refused = Object.entries(privatePagesRefused(theme.privatePages)) as Array<[PrivatePageKey, PrivatePageRefusal[]]>;
  if (refused.length === 0) return null;
  return (
    <Alert variant="warning" data-private-pages-fallback>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription>
        <div className="space-y-2">
          <p>{t("help")}</p>
          <ul className="list-disc space-y-1 ps-5">
            {refused.map(([page, issues]) => {
              const first = issues[0]!;
              return (
                <li key={page} data-private-page-fallback={page}>
                  <p>{t("line", { page: t(`page_${page}`), why: t(`why_${privateRefusalWhy(first)}`) })}</p>
                  <p className="text-muted-foreground">{t("detail", { message: first.message })}</p>
                </li>
              );
            })}
          </ul>
          <p>{t("fix")}</p>
        </div>
      </AlertDescription>
    </Alert>
  );
}
