/**
 * Which header, footer or product card the store draws: the theme's own, or
 * one an installed app fills (`apps.header`, `apps.footer`,
 * `apps.productCard`). With an app's chosen, its settings come first and the
 * built-in settings stay below as the fallback: the store draws the
 * built-in block while the app is not active or draws nothing. Where no app
 * offers the slot, the built-in settings show alone, as before.
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
import { appSlotFieldPrefix, setThemeAppSlot, themeAppSlot, type AppSlotEntry, type AppSlotKind } from "../theme-settings";

/** The built-in block's choice (app keys always hold a slash). */
const BUILT_IN = "built-in";

/**
 * Where the built-in settings sit: `alone` (no app offers the slot), `below`
 * the choice, or folded into the `fallback` group under an app's settings.
 */
export type SlotSettingsPlace = "alone" | "below" | "fallback";

/** The built-in settings as the store's fallback, folded until opened. */
function Fallback({ children }: { children: ReactNode }) {
  const t = useMessages(themeEditorMessages);
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-border" data-app-slot-fallback>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((current) => !current)}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-start text-body font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
        >
          {t("slotFallback")}
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-180")} aria-hidden="true" />
        </button>
      </h3>
      {open ? (
        <div id={`${id}-body`} className="space-y-4 border-t border-border px-3 py-3">
          <p className="text-body text-muted-foreground">{t("slotFallbackHelp")}</p>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function AppSlotSettings({ slot, theme, apps, media, setDraft, children }: {
  slot: AppSlotKind;
  theme: Theme;
  apps: readonly ThemeApp[];
  media: MediaPreviews;
  setDraft: SetTheme;
  /** The built-in block's settings, for where they sit. */
  children: (place: SlotSettingsPlace) => ReactNode;
}) {
  const t = useMessages(themeEditorMessages);
  const labelId = useId();
  const offered: AppSlotEntry[] = apps.flatMap((app) => app.slots.filter((each) => each.slot === slot).map((each) => ({ app, slot: each })));
  const filled = themeAppSlot(theme, slot);
  if (offered.length === 0 && !filled) return <>{children("alone")}</>;
  const entry = filled ? offered.find((each) => each.slot.key === filled.app) : undefined;
  const choose = (key: string) => setDraft((current) => {
    if (key === BUILT_IN) return setThemeAppSlot(current, slot, null);
    const chosen = offered.find((each) => each.slot.key === key);
    // An inactive app stays chosen until another choice replaces it.
    return chosen ? setThemeAppSlot(current, slot, { app: key, values: appSettingDefaults(chosen.slot.settings) }) : current;
  });
  const options = [
    { value: BUILT_IN, label: t(`slotBuiltIn_${slot}`), help: t("slotBuiltInHelp") },
    ...offered.map(({ app, slot: each }) => ({
      value: each.key,
      label: each.name,
      help: `${each.description ? `${each.description} ` : ""}${t("appFrom", { app: app.name })}`,
    })),
    // A chosen app that is not active stays listed, saying so, until another is chosen.
    ...(filled && !entry ? [{ value: filled.app, label: filled.app, help: t("appInactive") }] : []),
  ];
  return (
    <div className="space-y-4" data-app-slot={slot}>
      <div className="space-y-2">
        <p id={labelId} className="text-body font-medium">{t(`slotChoice_${slot}`)}</p>
        <RadioGroup value={filled?.app ?? BUILT_IN} aria-labelledby={labelId} onValueChange={choose}>
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
      {filled ? (
        <>
          {!entry ? (
            <p role="status" className="text-body text-muted-foreground">{t("slotAppInactive", { app: filled.app })}</p>
          ) : themeAppFields(entry.slot.settings).length > 0 ? (
            <AppSettingFields
              idPrefix={appSlotFieldPrefix(slot)}
              fields={entry.slot.settings}
              values={filled.values}
              media={media}
              onChange={(values) => setDraft((current) => {
                const now = themeAppSlot(current, slot);
                return now ? setThemeAppSlot(current, slot, { ...now, values }) : current;
              })}
            />
          ) : (
            <p className="text-body text-muted-foreground">{t("slotNoSettings")}</p>
          )}
          <Fallback>{children("fallback")}</Fallback>
        </>
      ) : children("below")}
    </div>
  );
}
