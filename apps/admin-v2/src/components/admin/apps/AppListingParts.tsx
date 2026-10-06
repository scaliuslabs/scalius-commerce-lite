// The listing an app page and an available app's preview share (Shopify's
// app details): screenshots, then facts about who made it, where it works and
// where to get help. Every value comes from the app's manifest.
import type { ReactNode } from "react";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import { countryName } from "~/lib/country-name";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import type { AppListing } from "~/lib/api-query-options/apps";

export type ListingFields = Pick<
  AppListing,
  | "name" | "version" | "author" | "homepage" | "categories" | "countries" | "screenshots" | "support"
  | "privacyPolicyUrl" | "documentationUrl" | "changelogUrl" | "minPlatformVersion"
>;

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-body text-muted-foreground">{label}</dt>
      <dd className="break-words text-body">{children}</dd>
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
      {children}
    </a>
  );
}

/** Up to six screenshots in one row that scrolls sideways, each at a fixed height. */
export function AppScreenshots({ app }: { app: Pick<ListingFields, "name" | "screenshots"> }) {
  const t = useMessages(installedAppsMessages);
  if (app.screenshots.length === 0) return null;
  return (
    <ul aria-label={t("screenshots")} className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
      {app.screenshots.map((src, index) => (
        <li key={src} className="shrink-0 snap-start">
          <img
            src={withDashboardBasePath(src)}
            alt={t("screenshotAlt", { name: app.name, number: index + 1 })}
            loading="lazy"
            decoding="async"
            className="h-40 w-auto max-w-72 rounded-lg bg-muted object-contain shadow-card sm:h-48"
          />
        </li>
      ))}
    </ul>
  );
}

/** Developer, version, categories, countries, platform floor and links: only what the app declares. */
export function AppListingFacts({ app, children }: { app: ListingFields; children?: ReactNode }) {
  const t = useMessages(installedAppsMessages);
  const { support } = app;
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      <Fact label={t("developer")}>
        {app.author.url ? <ExternalLink href={app.author.url}>{app.author.name}</ExternalLink> : app.author.name}
      </Fact>
      <Fact label={t("version")}><span className="font-mono">{app.version}</span></Fact>
      {app.categories.length > 0 ? (
        <Fact label={t("categories")}>{app.categories.map((category) => t(`category_${category}`)).join(", ")}</Fact>
      ) : null}
      <Fact label={t("countries")}>{app.countries ? app.countries.map(countryName).join(", ") : t("everyCountry")}</Fact>
      {app.minPlatformVersion ? <Fact label={t("requires")}>{t("requiresVersion", { version: app.minPlatformVersion })}</Fact> : null}
      {app.homepage ? <Fact label={t("website")}><ExternalLink href={app.homepage}>{app.homepage}</ExternalLink></Fact> : null}
      {support ? (
        <Fact label={t("support")}>
          <span className="flex flex-col gap-0.5">
            {support.url ? <ExternalLink href={support.url}>{support.url}</ExternalLink> : null}
            {support.email ? <a href={`mailto:${support.email}`} className="text-link hover:underline">{support.email}</a> : null}
          </span>
        </Fact>
      ) : null}
      {app.documentationUrl ? <Fact label={t("documentation")}><ExternalLink href={app.documentationUrl}>{app.documentationUrl}</ExternalLink></Fact> : null}
      {app.privacyPolicyUrl ? <Fact label={t("privacyPolicy")}><ExternalLink href={app.privacyPolicyUrl}>{app.privacyPolicyUrl}</ExternalLink></Fact> : null}
      {app.changelogUrl ? <Fact label={t("changelog")}><ExternalLink href={app.changelogUrl}>{app.changelogUrl}</ExternalLink></Fact> : null}
      {children}
    </dl>
  );
}
