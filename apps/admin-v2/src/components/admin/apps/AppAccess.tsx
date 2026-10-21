// What an app asks to do, in plain words: the consent list the app page and
// the activation dialog share. Built only from the API's grant request; when
// an update asks for more than was approved, the additions are marked "New".
import type { ReactNode } from "react";
import { PROVIDER_PORT_TIERS, type ProviderKind } from "@scalius/shared/plugins/providers/kinds";
import { Badge } from "~/components/ui/badge";
import { getLocale, useMessages } from "~/i18n";
import { formatList } from "@scalius/shared/locale-words";
import { appScopeMessages } from "~/i18n/app-scopes";
import { installedAppsMessages } from "~/i18n/apps";
import { customFieldMessages, type CustomFieldMessageKey } from "~/i18n/custom-fields";
import { APP_FUNCTION_POINTS, type AppDetail, type AppGrant } from "~/lib/api-query-options/apps";
import { topicLabel } from "../settings/webhooks/webhook-format";
import { RISK_VARIANT } from "./app-status";

const PROVIDER_KINDS = [
  "payment", "courier", "sms", "email", "courier_history", "tax", "translation", "ai",
  "messaging", "push", "search", "address", "fx", "identity",
] as const;

function known<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

type ListKey = { [K in keyof AppGrant]-?: AppGrant[K] extends string[] ? K : never }[keyof AppGrant];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-body font-medium">{title}</h3>
      <ul className="space-y-1.5">{children}</ul>
    </section>
  );
}

/**
 * `consent` is the sentence that agrees to the list ("… can read and change what
 * is listed"): it shows under the list, and only when something is listed.
 */
const SKIN_UNITS = ["header", "footer", "product_card", "product_main", "listing_main"] as const;

/** What the app's own storefront code draws, in plain words (only what it declares). */
function storefrontParts(app: Pick<AppDetail, "storefront">, t: (key: string) => string): string {
  const { sections = [], components = [], skins = [] } = app.storefront ?? {};
  const parts: string[] = [];
  if (sections.length > 0) parts.push(t("storefrontPart_sections"));
  if (components.length > 0) parts.push(t("storefrontPart_blocks"));
  for (const unit of SKIN_UNITS) if (skins.some((skin) => skin.target === unit)) parts.push(t(`storefrontPart_${unit}`));
  if (skins.some((skin) => skin.target.startsWith("section:"))) parts.push(t("storefrontPart_section"));
  return formatList(parts.length > 0 ? parts : [t("storefrontPart_other")], getLocale());
}

export function AppAccess({ app, consent }: { app: AppDetail; consent?: ReactNode }) {
  const t = useMessages(installedAppsMessages);
  const scopeText = useMessages(appScopeMessages);
  const fieldOwner = useMessages(customFieldMessages);
  const { request } = app;
  // Before the first approval everything is new, so nothing is marked.
  const added = (app.granted as AppGrant | null) ? app.added : null;
  const isNew = (list: ListKey, value: string) => added !== null && (added[list] as readonly string[]).includes(value);
  const newBadge = (on: boolean) => (on ? <Badge variant="info">{t("new")}</Badge> : null);
  const row = (key: string, content: ReactNode, fresh: boolean) => (
    <li key={key} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body">
      {content}
      {newBadge(fresh)}
    </li>
  );

  const sections: ReactNode[] = [];
  if (app.scopes.length > 0) {
    sections.push(
      <Section key="data" title={t("access_data")}>
        {app.scopes.map((scope) => (
          <li key={scope.name} className="flex items-start justify-between gap-3 text-body">
            <span className="min-w-0 space-y-0.5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{scopeText(`scope_${scope.name}`)}</span>
                {newBadge(isNew("scopes", scope.name))}
              </span>
              <span className="block text-caption text-muted-foreground">{scopeText(`scope_${scope.name}_help`)}</span>
            </span>
            <span className="flex shrink-0 flex-wrap justify-end gap-1">
              {scope.sensitive ? <Badge variant="attention">{t("sensitive")}</Badge> : null}
              <Badge variant={RISK_VARIANT[scope.risk]}>{t(`risk_${scope.risk}`)}</Badge>
            </span>
          </li>
        ))}
      </Section>,
    );
  }
  if (request.events.length > 0) {
    sections.push(
      <Section key="events" title={t("access_events")}>
        {request.events.map((topic) => row(topic, topicLabel(topic), isNew("events", topic)))}
      </Section>,
    );
  }
  if (request.functions.length > 0) {
    const pointLabel = (point: string) => (known(APP_FUNCTION_POINTS, point) ? t(`function_${point}`) : point);
    sections.push(
      <Section key="checkout" title={t("access_checkout")}>
        {request.functions.map((point) =>
          row(point, known(APP_FUNCTION_POINTS, point) ? t(`function_${point}`) : <span className="font-mono">{point}</span>, isNew("functions", point)),
        )}
        {request.blockingFunctions.map((point) =>
          row(`block:${point}`, t("checkoutBlocking", { point: pointLabel(point) }), isNew("blockingFunctions", point)),
        )}
        {app.functions.flatMap((fn) => fn.reads.flatMap((read) => (read.object
          ? [row(`reads:${fn.point}:${read.as}`, t(fn.point === "checkout.discounts" ? "checkoutReadsUpdate" : "checkoutReads", { collection: read.object }), false)]
          : [row(`reads:${fn.point}:${read.as}`, t("checkoutReadsFields", { fields: read.customFields.join(", ") }), false)])))}
      </Section>,
    );
  }
  if (request.providers.length > 0) {
    sections.push(
      <Section key="services" title={t("access_services")}>
        {request.providers.map((kind) => row(
          kind,
          known(PROVIDER_KINDS, kind)
            ? (
              <>
                {t(`provider_${kind}`)}
                {PROVIDER_PORT_TIERS[kind as ProviderKind] === "beta" ? <Badge variant="outline" title={t("betaPortHelp")}>{t("betaPort")}</Badge> : null}
              </>
            )
            : kind,
          isNew("providers", kind),
        ))}
      </Section>,
    );
  }
  const connect = request.storefrontConnect ?? [];
  const extensions = request.extensions ?? [];
  if (request.storefrontSurfaces || extensions.length > 0 || request.publicRoutes || request.storefrontScripts.length > 0 || request.storefrontCode || connect.length > 0) {
    sections.push(
      <Section key="storefront" title={t("access_storefront")}>
        {request.storefrontSurfaces ? row("surfaces", t("storefrontSurfaces"), added?.storefrontSurfaces === true) : null}
        {extensions.length > 0 ? row("extensions", t("storefrontExtensions"), (added?.extensions?.length ?? 0) > 0) : null}
        {[...new Map((app.extensions ?? []).flatMap((extension) => extension.reads).map((read) => [read.as, read])).values()].map((read) => (read.object
          ? row(`extension-reads:${read.as}`, t("extensionReads", { collection: read.object }), false)
          : row(`extension-reads:${read.as}`, t("extensionReadsFields", { fields: read.customFields.join(", ") }), false)))}
        {request.storefrontCode ? row("code", t("storefrontCode", { parts: storefrontParts(app, t) }), added?.storefrontCode === true) : null}
        {request.publicRoutes ? row("public", t("publicRoutes"), added?.publicRoutes === true) : null}
        {request.storefrontScripts.map((host) => {
          // "Loads scripts from {host}", with the host as code wherever the language puts it.
          const [before, after] = t("scriptsFrom", { host: "\u0000" }).split("\u0000");
          return row(`script:${host}`, <span className="break-all">{before}<code>{host}</code>{after}</span>, isNew("storefrontScripts", host));
        })}
        {connect.map((host) => {
          // "Its storefront code connects to {host}" (never loads scripts from it).
          const [before, after] = t("storefrontConnectTo", { host: "\u0000" }).split("\u0000");
          return row(`connect:${host}`, <span className="break-all">{before}<code>{host}</code>{after}</span>, added?.storefrontConnect?.includes(host) === true);
        })}
      </Section>,
    );
  }
  if (request.allowedHosts.length > 0) {
    sections.push(
      <Section key="hosts" title={t("access_hosts")}>
        {request.allowedHosts.map((host) => row(host, <span className="break-all font-mono">{host}</span>, isNew("allowedHosts", host)))}
      </Section>,
    );
  }
  if (request.customFieldOwners.length > 0) {
    sections.push(
      <Section key="fields" title={t("access_fields")}>
        {request.customFieldOwners.map((owner) => {
          const key = `owner.${owner}`;
          return row(owner, key in customFieldMessages.en ? fieldOwner(key as CustomFieldMessageKey) : owner, isNew("customFieldOwners", owner));
        })}
      </Section>,
    );
  }

  const recipients = request.messageRecipients ?? [];
  if (recipients.length > 0) {
    sections.push(
      <Section key="messages" title={t("access_messages")}>
        {recipients.map((field) => {
          // "Can email or text any address it stores in its {field} records ...", with the field as code.
          const [before, after] = t("messageRecipientsIn", { field: "\u0000" }).split("\u0000");
          return row(`recipient:${field}`, <span className="break-all">{before}<code>{field}</code>{after}</span>, isNew("messageRecipients", field));
        })}
      </Section>,
    );
  }

  if (sections.length === 0) return <p className="text-body text-muted-foreground">{t("noAccess")}</p>;
  return (
    <>
      <div className="space-y-4">{sections}</div>
      {consent}
    </>
  );
}
