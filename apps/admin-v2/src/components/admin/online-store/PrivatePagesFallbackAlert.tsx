// What shoppers see of the live theme that is not the theme as published,
// each in plain words with its fix: the stored theme does not read (shoppers
// see the default theme); a part the read left out (a link, a bottom bar tab,
// an unknown setting); private pages waiting for the store's compile after an
// update; private pages the compile refused (`compiled.refused`, the save's
// own issues: which page, why, the store's check word for word); and a page
// paint that no longer reaches the cart and payment step. Nothing while the
// live theme draws as published.
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import {
  privatePageNamed,
  privatePagesPending,
  privatePagesRefused,
  type PrivatePageKey,
  type PrivatePageRefusal,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { getLocale, useMessages } from "~/i18n";
import { formatList } from "@scalius/shared/locale-words";
import { themePrivateFallbackMessages } from "~/i18n/theme-private-fallback";

type Why = "readability" | "prominence" | "style" | "layout" | "words" | "files" | "unavailable" | "size" | "unfinished" | "other";
type RepairPart = "tab" | "link" | "slide" | "layout" | "words" | "unknown";

/** Why a page was refused, in the merchant's terms: by where the refused value sits, then its reason. */
export function privateRefusalWhy(refusal: PrivatePageRefusal): Why {
  if (refusal.reason === "not_available") return "unavailable";
  if (refusal.reason === "too_large") return "size";
  if (refusal.reason === "compile_unfinished") return "unfinished";
  if (refusal.reason === "foreign_asset") return "files";
  const [, place] = refusal.path.split(".");
  if (place === "pages") return "layout";
  if (place === "labels") return "words";
  if (place === "tokens") return refusal.reason === "contrast" ? "readability" : refusal.reason === "prominence" ? "prominence" : "style";
  return "other";
}

/** What a read left out, in the merchant's terms. */
export function themeRepairPart(repair: { path: string; reason: string }): RepairPart {
  if (repair.reason.startsWith("tab_") || repair.path.includes(".tabs.")) return "tab";
  if (repair.reason === "invalid_link") return "link";
  if (repair.reason === "slide_products_over_limit") return "slide";
  if (repair.reason === "too_deep" || repair.path.startsWith("privatePages.pages")) return "layout";
  if (repair.reason.startsWith("label_")) return "words";
  return "unknown";
}

export interface LiveThemeHealth {
  theme: StorefrontThemeDocument;
  /** The stored live theme did not read, and why (`theme` is then the default shoppers see). */
  unreadable?: string | null;
  /** What the read of the stored live theme left out. */
  repairs?: ReadonlyArray<{ path: string; reason: string }>;
}

export function PrivatePagesFallbackAlert({ theme, unreadable = null, repairs = [] }: LiveThemeHealth) {
  const t = useMessages(themePrivateFallbackMessages);
  if (unreadable) {
    return (
      <Alert variant="destructive" data-live-theme-unreadable>
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{t("unreadableTitle")}</AlertTitle>
        <AlertDescription>
          <p>{t("unreadableHelp")}</p>
          <p className="text-muted-foreground">{t("detail", { message: unreadable })}</p>
        </AlertDescription>
      </Alert>
    );
  }
  const refused = Object.entries(privatePagesRefused(theme.privatePages)) as Array<[PrivatePageKey, PrivatePageRefusal[]]>;
  const pending = privatePagesPending(theme.privatePages);
  const parts = [...new Set(repairs.map(themeRepairPart))];
  const paintAlone = theme.tokens.pagePaint !== undefined && !privatePageNamed(theme.privatePages, "cart") && !privatePageNamed(theme.privatePages, "checkout");
  return (
    <>
      {parts.length > 0 ? (
        <Alert variant="warning" data-live-theme-repairs>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t("repairsTitle")}</AlertTitle>
          <AlertDescription>{t("repairsHelp", { parts: formatList(parts.map((part) => t(`repair_${part}`)), getLocale()) })}</AlertDescription>
        </Alert>
      ) : null}
      {pending.length > 0 ? (
        <Alert variant="info" data-private-pages-pending>
          <Info aria-hidden="true" />
          <AlertTitle>{t("pendingTitle")}</AlertTitle>
          <AlertDescription>{t("pendingHelp", { pages: formatList(pending.map((page) => t(`page_${page}`)), getLocale()) })}</AlertDescription>
        </Alert>
      ) : null}
      {refused.length > 0 ? (
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
      ) : null}
      {paintAlone ? (
        <Alert variant="info" data-page-paint-public-only>
          <Info aria-hidden="true" />
          <AlertTitle>{t("paintTitle")}</AlertTitle>
          <AlertDescription>{t("paintHelp")}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/** In the editor's page panel: the draft's page that its compile refused (a page a save keeps refused, with why). */
export function PrivatePageRefusalNote({ theme, page }: { theme: StorefrontThemeDocument; page: PrivatePageKey }) {
  const t = useMessages(themePrivateFallbackMessages);
  const first = privatePagesRefused(theme.privatePages)[page]?.[0];
  if (!first) return null;
  return (
    <Alert variant="warning" data-private-page-refused={page}>
      <TriangleAlert aria-hidden="true" />
      <AlertDescription>{t("draftRefused", { why: t(`why_${privateRefusalWhy(first)}`), message: first.message })}</AlertDescription>
    </Alert>
  );
}
