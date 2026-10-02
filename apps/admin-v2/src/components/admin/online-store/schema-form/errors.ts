import type { SettingMessageKey } from "./labels";

interface Issue {
  code: string;
  path: PropertyKey[];
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
}

interface Parsable {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: Issue[] } };
}

export interface SettingError {
  key: SettingMessageKey;
  values?: Record<string, number>;
}

/**
 * What a settings value breaks, by data path (`slides.0.alt`; `""` for the
 * whole value), as message keys: required text, too long, too few or too
 * many items, a link that is not usable, an item listed twice.
 */
export function settingErrors(schema: Parsable, value: unknown): Map<string, SettingError> {
  const result = schema.safeParse(value);
  const errors = new Map<string, SettingError>();
  if (result.success) return errors;
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join(".");
    if (errors.has(path)) continue;
    if (issue.code === "too_small" && issue.origin === "array") {
      errors.set(path, { key: "form.count", values: { count: Number(issue.minimum) } });
    } else if (issue.code === "too_big" && issue.origin === "array") {
      errors.set(path, { key: "form.tooMany", values: { count: Number(issue.maximum) } });
    } else if (issue.code === "too_big") {
      errors.set(path, { key: "form.tooLong" });
    } else if (issue.code === "invalid_format" || /(?:^|\.)(?:href|link)$/.test(path)) {
      errors.set(path, { key: "form.linkInvalid" });
    } else if (issue.code === "custom") {
      errors.set(path, { key: "form.unique" });
    } else {
      errors.set(path, { key: "form.required" });
    }
  }
  return errors;
}
