// The theme parts an app draws, in plain words: the warning in the
// deactivate and uninstall confirmations (the published parts that fall back
// to the store's own design), and the theme editor's refused publish (each
// app that is not ready, its parts, and a link to the app's page, where a
// Super Admin activates it).
import { Link } from "@tanstack/react-router";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { useMessages } from "~/i18n";
import { themeAppPartsMessages } from "~/i18n/theme-app-parts";
import { themeAppPartText, type ThemeAppPart, type ThemeAppsProblem } from "./theme-app-parts";

export function ThemeAppPartList({ parts, more }: { parts: readonly ThemeAppPart[]; more: number }) {
  const t = useMessages(themeAppPartsMessages);
  return (
    <ul className="list-disc space-y-0.5 ps-5" data-theme-app-parts>
      {parts.map((part) => <li key={part.path}>{themeAppPartText(part, t)}</li>)}
      {more > 0 ? <li>{t("partsMore", { count: more })}</li> : null}
    </ul>
  );
}

/** Before an app stops: the published theme's parts it draws. Nothing when it draws none. */
export function ThemeAppFallbackNotice({ name, usage, action }: {
  name: string;
  usage: { parts: readonly ThemeAppPart[]; more: number } | undefined;
  action: "deactivate" | "uninstall";
}) {
  const t = useMessages(themeAppPartsMessages);
  if (!usage || usage.parts.length === 0) return null;
  return (
    <Alert variant="warning" data-theme-app-fallback>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{t("fallbackTitle", { name })}</AlertTitle>
      <AlertDescription>
        <p>{t(action === "deactivate" ? "fallbackDeactivate" : "fallbackUninstall", { name })}</p>
        <ThemeAppPartList parts={usage.parts} more={usage.more} />
      </AlertDescription>
    </Alert>
  );
}

/** A refused publish: each app that is not ready, why, its parts and its page. */
export function ThemeAppsUnavailableAlert({ apps, moreParts }: { apps: readonly ThemeAppsProblem[]; moreParts: number }) {
  const t = useMessages(themeAppPartsMessages);
  return (
    <Alert variant="destructive" data-theme-apps-unavailable>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{t("unavailableTitle")}</AlertTitle>
      <AlertDescription>
        <div className="space-y-3">
          <p>{t("unavailableHelp")}</p>
          {apps.map((app) => {
            const name = app.name ?? app.pluginId;
            const reason = app.reason === "not_declared" ? "unavailableNotDeclared" : app.name ? "unavailableInactive" : "unavailableMissing";
            return (
              <div key={app.pluginId} className="space-y-1" data-theme-app={app.pluginId}>
                <p>{t(reason, { name })}</p>
                <ThemeAppPartList parts={app.parts} more={0} />
                {app.name ? (
                  <Link to="/admin/apps/$pluginId" params={{ pluginId: app.pluginId }} className="font-medium text-link hover:underline">
                    {t("openApp", { name })}
                  </Link>
                ) : (
                  <Link to="/admin/apps" className="font-medium text-link hover:underline">{t("openApps")}</Link>
                )}
              </div>
            );
          })}
          {moreParts > 0 ? <p>{t("unavailableMore", { count: moreParts })}</p> : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}
