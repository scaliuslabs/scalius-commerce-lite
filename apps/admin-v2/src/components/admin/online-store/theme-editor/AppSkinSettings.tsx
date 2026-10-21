/**
 * Which design the store draws for a part: the theme's own, or an installed
 * app's skin of it. A unit (header, footer, product card, product page,
 * product listing) keeps its choice in `apps.skins.<unit>`; a core section
 * (a delivery and trust strip, a banner) on its placement, `section.skin`.
 *
 * With an app's design chosen, its settings come first. For a unit the
 * theme's own settings fold below as what the store shows while the app is
 * off or cannot draw. A section's own settings stay open below: the app's
 * design draws the same content (its words, items and links), only styled
 * its way. Where no app offers a design for the part, its settings show
 * alone, as before. A design the store recently drew without says so here.
 */
import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import type { StorefrontPlatformSection, StorefrontSkinRef } from "@scalius/shared/storefront-theme";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useMessages } from "~/i18n";
import { themeEditorFull } from "~/i18n/theme-editor-panes";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
import { StorefrontProblemNotice } from "~/components/admin/apps/StorefrontProblemNotice";
import { appSettingDefaults, themeAppFields } from "../schema-form/app-settings";
import { AppSettingFields } from "../schema-form/AppSettingFields";
import type { MediaPreviews } from "../schema-form/media-previews";
import type { SetTheme, Theme } from "../theme-fields";
import { appSkinFieldPrefix, setThemeAppSkin, themeAppSkin, type AppSkinEntry, type AppSkinUnit } from "../theme-settings";

/** The built-in choice (app keys always hold a slash). */
const BUILT_IN = "built-in";

/**
 * Where the built-in settings sit: `alone` (no app offers a skin), `below`
 * the choice, or folded into the `fallback` group under an app's settings.
 */
export type SkinSettingsPlace = "alone" | "below" | "fallback";

type UpdateSkin = (update: (current: StorefrontSkinRef | null) => StorefrontSkinRef | null) => void;

/** The built-in settings as the store's fallback, folded until opened. */
function Fallback({ children }: { children: ReactNode }) {
  const t = useMessages(themeEditorFull);
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-border" data-app-skin-fallback>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((current) => !current)}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-start text-body font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
        >
          {t("skinFallback")}
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-180")} aria-hidden="true" />
        </button>
      </h3>
      {open ? (
        <div id={`${id}-body`} className="space-y-4 border-t border-border px-3 py-3">
          <p className="text-body text-muted-foreground">{t("skinFallbackHelp")}</p>
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** The choice between the theme's design and the apps' designs of one part, with the chosen app's settings. */
function SkinPicker({ target, offered, chosen, update, media, idPrefix, choiceLabel, builtInLabel, children, keepBelow }: {
  /** The skin target: a unit or `section:<type>`. */
  target: string;
  offered: readonly AppSkinEntry[];
  chosen: StorefrontSkinRef | null;
  update: UpdateSkin;
  media: MediaPreviews;
  idPrefix: string;
  choiceLabel: string;
  builtInLabel: string;
  children: (place: SkinSettingsPlace) => ReactNode;
  /** The part's own settings stay open below an app's design (a section's content). */
  keepBelow: boolean;
}) {
  const t = useMessages(themeEditorFull);
  const labelId = useId();
  if (offered.length === 0 && !chosen) return <>{children("alone")}</>;
  const entry = chosen ? offered.find((each) => each.skin.key === chosen.app) : undefined;
  const choose = (key: string) => update((current) => {
    if (key === BUILT_IN) return null;
    const picked = offered.find((each) => each.skin.key === key);
    // An inactive app stays chosen until another choice replaces it.
    return picked ? { app: key, values: appSettingDefaults(picked.skin.settings) } : current;
  });
  const options = [
    { value: BUILT_IN, label: builtInLabel, help: t("skinBuiltInHelp") },
    ...offered.map(({ app, skin }) => ({
      value: skin.key,
      label: skin.name,
      help: `${skin.description ? `${skin.description} ` : ""}${t("appFrom", { app: app.name })}`,
    })),
    // A chosen app that is not active stays listed, saying so, until another is chosen.
    ...(chosen && !entry ? [{ value: chosen.app, label: t("skinInactiveLabel"), help: t("appInactive") }] : []),
  ];
  const [pluginId, skinId] = chosen ? [chosen.app.slice(0, chosen.app.indexOf("/")), chosen.app.slice(chosen.app.indexOf("/") + 1)] : ["", ""];
  return (
    <div className="space-y-4" data-app-skin={target}>
      <div className="space-y-2">
        <p id={labelId} className="text-body font-medium">{choiceLabel}</p>
        <RadioGroup value={chosen?.app ?? BUILT_IN} aria-labelledby={labelId} onValueChange={choose}>
          {options.map((option) => (
            <label key={option.value} className="flex min-h-11 items-start gap-2 py-1 text-body">
              <span className="flex h-lh items-center"><RadioGroupItem value={option.value} /></span>
              <span className="min-w-0">
                <span className="block font-medium">{option.label}</span>
                <span className="block text-muted-foreground">{option.help}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </div>
      {chosen ? (
        <>
          {entry ? <StorefrontProblemNotice appId={pluginId} part={{ kind: "skin", type: skinId, target }} /> : null}
          {!entry ? (
            <p role="status" className="text-body text-muted-foreground">{t("skinAppInactive")}</p>
          ) : themeAppFields(entry.skin.settings).length > 0 ? (
            <AppSettingFields
              idPrefix={idPrefix}
              fields={entry.skin.settings}
              values={chosen.values}
              bindings={chosen.bindings}
              onBindingsChange={(bindings) => update((now) => (now ? { ...now, bindings } : now))}
              media={media}
              onChange={(values) => update((now) => (now ? { ...now, values } : now))}
            />
          ) : (
            <p className="text-body text-muted-foreground">{t("skinNoSettings")}</p>
          )}
          {keepBelow ? children("below") : <Fallback>{children("fallback")}</Fallback>}
        </>
      ) : children("below")}
    </div>
  );
}

/** The apps' skins of one target, each with its app. */
function offeredSkins(apps: readonly ThemeApp[], target: string): AppSkinEntry[] {
  return apps.flatMap((app) => app.skins.filter((each) => each.target === target).map((each) => ({ app, skin: each })));
}

export function AppSkinSettings({ unit, theme, apps, media, setDraft, children }: {
  unit: AppSkinUnit;
  theme: Theme;
  apps: readonly ThemeApp[];
  media: MediaPreviews;
  setDraft: SetTheme;
  /** The built-in unit's settings, for where they sit. */
  children: (place: SkinSettingsPlace) => ReactNode;
}) {
  const t = useMessages(themeEditorFull);
  return (
    <SkinPicker
      target={unit}
      offered={offeredSkins(apps, unit)}
      chosen={themeAppSkin(theme, unit)}
      update={(change) => setDraft((current) => setThemeAppSkin(current, unit, change(themeAppSkin(current, unit))))}
      media={media}
      idPrefix={appSkinFieldPrefix(unit)}
      choiceLabel={t(`skinChoice_${unit}`)}
      builtInLabel={t(`skinBuiltIn_${unit}`)}
      keepBelow={false}
    >
      {children}
    </SkinPicker>
  );
}

/** The field ids of a section skin's app settings start with this (`theme-section-skin-usp-1`). */
export const sectionSkinFieldPrefix = (sectionId: string) => `theme-section-skin-${sectionId}`;

/**
 * A core section's design: the theme's own, or an app's skin of the section
 * type (`section:<type>`), with the section's own settings below either way.
 */
export function SectionSkinSettings({ section, apps, media, onChange, children }: {
  section: StorefrontPlatformSection;
  apps: readonly ThemeApp[];
  media: MediaPreviews;
  /** Applies the section's new skin (null: the theme's own design). */
  onChange: (update: (current: StorefrontSkinRef | null) => StorefrontSkinRef | null) => void;
  children: ReactNode;
}) {
  const t = useMessages(themeEditorFull);
  return (
    <SkinPicker
      target={`section:${section.type}`}
      offered={offeredSkins(apps, `section:${section.type}`)}
      chosen={section.skin ?? null}
      update={onChange}
      media={media}
      idPrefix={sectionSkinFieldPrefix(section.id)}
      choiceLabel={t("skinChoice_section")}
      builtInLabel={t("skinBuiltIn_section")}
      keepBelow
    >
      {() => children}
    </SkinPicker>
  );
}
