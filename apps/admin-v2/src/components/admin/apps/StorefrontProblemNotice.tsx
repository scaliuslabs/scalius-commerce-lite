/**
 * An app's storefront part the store recently drew without (the app's log,
 * `GET /admin/apps/storefront-problems`): on the app's page, and beside the
 * section, block or design in the theme editor, so a chosen skin that falls
 * back is never silent. Says what, why in plain words and what shoppers saw,
 * and links to the app's activity; it names no buyer and no page.
 */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { useMessages } from "~/i18n";
import { appStorefrontProblemMessages } from "~/i18n/app-storefront-problems";
import { appStorefrontProblemsQueryOptions, type AppStorefrontProblem } from "~/lib/api-query-options/apps";
import { formatWhen } from "../settings/webhooks/webhook-format";

/** Which part a notice is about: any of the app's, or one section, block or skin. */
export interface StorefrontPart {
  kind: "section" | "component" | "skin";
  /** The section type, component type or skin id. */
  type: string;
  /** A skin's target (`product_card`, `section:usp_strip`); a component's slot. */
  target?: string;
}

/** The app's newest problem that is about this part (any part when none is named). */
export function storefrontProblemFor(problems: readonly AppStorefrontProblem[], appId: string, part?: StorefrontPart): AppStorefrontProblem | null {
  return problems.find((problem) => problem.id === appId && (!part || (
    problem.kind === part.kind && problem.type === part.type && (part.target === undefined || problem.target === part.target)
  ))) ?? null;
}

export function StorefrontProblemNotice({ appId, part, link = true }: {
  appId: string;
  part?: StorefrontPart;
  /** Offer the app's page (not on the app's page itself). */
  link?: boolean;
}) {
  const t = useMessages(appStorefrontProblemMessages);
  const { data } = useQuery(appStorefrontProblemsQueryOptions());
  const problem = data ? storefrontProblemFor(data, appId, part) : null;
  if (!problem) return null;
  const kind = part?.kind ?? problem.kind;
  const title = !part ? t("title") : kind === "skin" ? t("titleSkin") : kind === "section" ? t("titleSection") : t("titleBlock");
  const when = formatWhen(problem.at);
  return (
    <Alert variant="warning" data-storefront-problem={appId}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>
          {t(problem.reason ? `reason_${problem.reason}` : "reason_unknown")}{" "}
          {t(kind === "skin" ? "insteadSkin" : "insteadPart")}
          {when ? ` ${t("when", { time: when })}` : ""}
        </p>
        <p>{t("whatToDo")}</p>
        {link ? (
          <Link to="/admin/apps/$pluginId" params={{ pluginId: appId }} className="text-link underline">{t("openApp")}</Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
