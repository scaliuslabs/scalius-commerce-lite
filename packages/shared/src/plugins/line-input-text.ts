// An app's line inputs (`checkout.lineInputs`) in a buyer's words: the
// manifest's text through its translations (`localizedLineInputs`), and where
// an input names one of the app's settings for its label, help or a choice's
// label, the merchant's text instead, in the buyer's language when the
// setting is translatable (`localizePluginSettingValues`: the page's
// language, then the store's default, then the setting's own value). Such an
// input carries the revision of its words (`textRevision`), so an answer
// records which words it was given to. The product page, checkout and the
// staff order form all resolve them here, so the words the buyer saw are the
// words the order line freezes. Browser-safe and free of I/O.
import { lineInputTextRevision, normalizePropertyText, type AppLineInputDeclaration } from "../line-properties";
import { localizedLineInputs } from "./manifest-text";
import type { PluginTranslation } from "./manifest";
import type { LineInputDeclaration } from "./buyer-ui";
import {
  localizePluginSettingValues,
  resolvePluginSettingValues,
  type PluginSettingLanguage,
  type PluginSettingsSchema,
} from "./settings-schema";

/** The app whose inputs are read: its settings schema and stored values. */
export interface LineInputTextSource {
  settings: PluginSettingsSchema;
  storedSettings: unknown;
}

const oneLine = (text: string) => text.replace(/\s+/gu, " ");

/** Whether an input names one of the app's settings: for its words, a choice's confirmation, or its decision. */
function namesSetting(input: LineInputDeclaration): boolean {
  return input.labelSetting !== undefined || input.helpSetting !== undefined || input.decision?.requiredSetting !== undefined
    || (input.options ?? []).some((option) => option.labelSetting !== undefined
      || option.confirm?.textSetting !== undefined || option.confirm?.titleSetting !== undefined || option.confirm?.agreeSetting !== undefined);
}

/** Whether the merchant may write some of the input's words (its revision then follows them). */
function wordsEditable(input: LineInputDeclaration): boolean {
  return input.labelSetting !== undefined || input.helpSetting !== undefined
    || (input.options ?? []).some((option) => option.labelSetting !== undefined
      || option.confirm?.textSetting !== undefined || option.confirm?.titleSetting !== undefined || option.confirm?.agreeSetting !== undefined);
}

/**
 * The inputs in the reader's words, without their setting references. An
 * empty setting (never set, or cleared) keeps the manifest's text; a label is
 * one line (runs of white space become one space). A choice's confirmation
 * takes the merchant's agreement, title and tick-box words the same way, and
 * the input's one `textRevision` covers them. An input that declares
 * `decision` keeps it only while its `requiredSetting` (a boolean setting) is
 * on, or always without one.
 */
export function appLineInputsInLanguage(
  inputs: readonly LineInputDeclaration[],
  app: LineInputTextSource,
  chain: readonly PluginTranslation[],
  language: PluginSettingLanguage | null,
): AppLineInputDeclaration[] {
  const localized = localizedLineInputs(inputs, chain);
  const values = inputs.some(namesSetting)
    ? localizePluginSettingValues(app.settings, resolvePluginSettingValues(app.settings, app.storedSettings), app.storedSettings, language)
    : {};
  const text = (key: string | undefined, line: boolean): string | undefined => {
    const value = key === undefined ? undefined : values[key];
    if (typeof value !== "string") return undefined;
    const normalized = normalizePropertyText(line ? oneLine(value) : value);
    return normalized === "" ? undefined : normalized;
  };
  return localized.map((input) => {
    const { labelSetting, helpSetting, options, decision, ...rest } = input;
    const help = text(helpSetting, false) ?? input.help;
    const required = decision !== undefined && (decision.requiredSetting === undefined || values[decision.requiredSetting] === true);
    const resolved: AppLineInputDeclaration = {
      ...rest,
      label: text(labelSetting, true) ?? input.label,
      ...(help !== undefined ? { help } : {}),
      ...(options ? {
        options: options.map(({ labelSetting: optionSetting, confirm, ...option }) => {
          if (!confirm) return { ...option, label: text(optionSetting, true) ?? option.label };
          const { textSetting, titleSetting, agreeSetting, ...words } = confirm;
          const title = text(titleSetting, true) ?? words.title;
          const agree = text(agreeSetting, true) ?? words.agree;
          return {
            ...option,
            label: text(optionSetting, true) ?? option.label,
            confirm: { text: text(textSetting, false) ?? words.text, ...(title !== undefined ? { title } : {}), ...(agree !== undefined ? { agree } : {}) },
          };
        }),
      } : {}),
      ...(required ? { decision: decision.proceedWith !== undefined ? { proceedWith: decision.proceedWith } : {} } : {}),
    };
    return wordsEditable(input) ? { ...resolved, textRevision: lineInputTextRevision(resolved) } : resolved;
  });
}
