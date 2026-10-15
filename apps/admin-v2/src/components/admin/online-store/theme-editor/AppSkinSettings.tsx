/**
 * Which header, footer, product card, product page or product listing the
 * store draws: the theme's own, or an installed app's skin of it
 * (`apps.skins.<unit>`). With an app's chosen, its settings come first and
 * the built-in settings stay below as the fallback: the store draws the
 * built-in one while the app is not active or draws nothing. Where no app
 * offers a skin of the unit, the built-in settings show alone, as before.
 */
import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { ThemeApp } from "~/lib/api-query-options/online-store";
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

/** The built-in settings as the store's fallback, folded until opened. */
function Fallback({ children }: { children: ReactNode }) {
  const t = useMessages(themeEditorMessages);
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

export function AppSkinSettings({ unit, theme, apps, media, setDraft, children }: {
  unit: AppSkinUnit;
  theme: Theme;
  apps: readonly ThemeApp[];
  media: MediaPreviews;
  setDraft: SetTheme;
  /** The built-in unit's settings, for where they sit. */
  children: (place: SkinSettingsPlace) => ReactNode;
}) {
  const t = useMessages(themeEditorMessages);
  const labelId = useId();
  const offered: AppSkinEntry[] = apps.flatMap((app) => app.skins.filter((each) => each.target === unit).map((each) => ({ app, skin: each })));
  const chosen = themeAppSkin(theme, unit);
  if (offered.length === 0 && !chosen) return <>{children("alone")}</>;
  const entry = chosen ? offered.find((each) => each.skin.key === chosen.app) : undefined;
  const choose = (key: string) => setDraft((current) => {
    if (key === BUILT_IN) return setThemeAppSkin(current, unit, null);
    const picked = offered.find((each) => each.skin.key === key);
    // An inactive app stays chosen until another choice replaces it.
    return picked ? setThemeAppSkin(current, unit, { app: key, values: appSettingDefaults(picked.skin.settings) }) : current;
  });
  const options = [
    { value: BUILT_IN, label: t(`skinBuiltIn_${unit}`), help: t("skinBuiltInHelp") },
    ...offered.map(({ app, skin }) => ({
      value: skin.key,
      label: skin.name,
      help: `${skin.description ? `${skin.description} ` : ""}${t("appFrom", { app: app.name })}`,
    })),
    // A chosen app that is not active stays listed, saying so, until another is chosen.
    ...(chosen && !entry ? [{ value: chosen.app, label: chosen.app, help: t("appInactive") }] : []),
  ];
  return (
    <div className="space-y-4" data-app-skin={unit}>
      <div className="space-y-2">
        <p id={labelId} className="text-body font-medium">{t(`skinChoice_${unit}`)}</p>
        <RadioGroup value={chosen?.app ?? BUILT_IN} aria-labelledby={labelId} onValueChange={choose}>
          {options.map((option) => (
            <label key={option.value} className="flex min-h-11 items-start gap-3 py-1 text-body">
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
          {!entry ? (
            <p role="status" className="text-body text-muted-foreground">{t("skinAppInactive", { app: chosen.app })}</p>
          ) : themeAppFields(entry.skin.settings).length > 0 ? (
            <AppSettingFields
              idPrefix={appSkinFieldPrefix(unit)}
              fields={entry.skin.settings}
              values={chosen.values}
              bindings={chosen.bindings}
              onBindingsChange={(bindings) => setDraft((current) => {
                const now = themeAppSkin(current, unit);
                return now ? setThemeAppSkin(current, unit, { ...now, bindings }) : current;
              })}
              media={media}
              onChange={(values) => setDraft((current) => {
                const now = themeAppSkin(current, unit);
                return now ? setThemeAppSkin(current, unit, { ...now, values }) : current;
              })}
            />
          ) : (
            <p className="text-body text-muted-foreground">{t("skinNoSettings")}</p>
          )}
          <Fallback>{children("fallback")}</Fallback>
        </>
      ) : children("below")}
    </div>
  );
}
