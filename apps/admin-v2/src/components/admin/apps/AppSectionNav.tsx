// The app page's section navigation (Stripe's settings column): Overview,
// the features under their kind, then Settings and Activity. A column beside
// the content from 1024px; above it, on phones and tablets, one picker that
// goes to the chosen section (never a tab strip that overflows). Each row
// says how its feature is: off, needs setup or not working; a feature that
// is on and ready says nothing.
import { Link, useNavigate } from "@tanstack/react-router";
import { Badge } from "~/components/ui/badge";
import { Card } from "~/components/ui/card";
import { Field } from "~/components/ui/field";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { appFeaturesMessages } from "~/i18n/app-features";
import { installedAppsMessages } from "~/i18n/apps";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { appSectionNav, appSectionPath, type AppSection } from "./app-sections";
import { SERVICE_HEALTH } from "./app-services";


const ROW =
  "flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-body outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-semibold lg:min-h-8";

export function AppSectionNav({ app, current }: { app: AppDetail; current: string }) {
  const t = useMessages(appFeaturesMessages);
  const apps = useMessages(installedAppsMessages);
  const navigate = useNavigate();
  const nav = appSectionNav(app);
  const label = (section: AppSection) =>
    section.kind === "feature" ? section.feature.name
      : section.kind === "overview" ? t("overview")
        : section.kind === "settings" ? apps("settingsTitle")
          : apps("activityTitle");
  /** How a feature is, in words: nothing while it is on and ready. */
  const state = (section: AppSection): string | null => {
    if (section.kind !== "feature") return null;
    if (!section.feature.enabled) return t("off");
    return section.health && section.health.status !== "ready" ? t(`status_${section.health.status}`) : null;
  };
  const options = nav.flatMap(({ group, sections }) => sections.map((section) => {
    const description = state(section);
    return {
      value: section.key,
      label: label(section),
      ...(description ? { description } : {}),
      ...(group ? { group: t(`group_${group}`) } : {}),
    };
  }));

  return (
    <>
      <div className="lg:hidden">
        <Field id="app-section" label={t("sectionPicker")}>
          <SearchableSelect
            id="app-section"
            value={current}
            triggerClassName="w-full"
            options={options}
            onValueChange={(key) => {
              if (key && key !== current) void navigate({ to: appSectionPath(app.id, key) });
            }}
          />
        </Field>
      </div>
      {/* eslint-disable-next-line no-restricted-syntax -- a side column holding one card, not a bar */}
      <nav aria-label={t("sectionsLabel", { app: app.name })} className="hidden lg:sticky lg:top-4 lg:block">
        <Card className="flex flex-col gap-0.5 p-1.5">
          {nav.map(({ group, sections }, index) => (
            <div key={group ?? `plain-${index}`} className="flex flex-col gap-0.5">
              {group ? <p className="px-2 pb-1 pt-3 text-body font-medium text-muted-foreground">{t(`group_${group}`)}</p> : index > 0 ? <div className="my-1 border-t border-border" /> : null}
              {sections.map((section) => {
                const words = state(section);
                const health = section.kind === "feature" && section.feature.enabled && section.health?.status !== "ready" ? section.health : null;
                return (
                  <Link
                    key={section.key}
                    to={appSectionPath(app.id, section.key)}
                    aria-current={section.key === current ? "page" : undefined}
                    className={ROW}
                  >
                    <span className="min-w-0 flex-1 truncate" title={label(section)}>{label(section)}</span>
                    {health ? (
                      <Badge variant={SERVICE_HEALTH[health.status].variant}>{words}</Badge>
                    ) : words ? (
                      <span className="shrink-0 text-body font-normal text-muted-foreground">{words}</span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </Card>
      </nav>
    </>
  );
}
