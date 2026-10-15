// A failed object write as the merchant reads it, in the dashboard
// language: the API's codes become plain sentences; a refusal with a field
// list stays with the save bar, which marks the fields.
import { translate } from "~/i18n";
import { objectMessages, type ObjectMessageKey } from "~/i18n/objects";
import { readAdminApiError, readAdminApiErrorCode } from "~/lib/admin-api-error";
import { SaveConflict, SaveNotCompleted } from "~/components/admin/shared/SaveBar";

type Kind = "type" | "entry";

/**
 * Throws a `SaveConflict` (stale revision) or a `SaveNotCompleted` with a
 * translated sentence for the codes the API names; returns for any other
 * error, which the caller rethrows for the save bar to describe.
 */
export function throwObjectSaveError(error: unknown, kind: Kind): void {
  const t = (key: ObjectMessageKey) => translate(objectMessages, key);
  switch (readAdminApiErrorCode(error)) {
    case "object.conflict":
    case "OBJECT_REVISION_CONFLICT":
      throw new SaveConflict(t(kind === "type" ? "typeChanged" : "entryChanged"));
    case "object.unique_violation":
      throw new SaveNotCompleted(t("entryUniqueTaken"));
    case "object.forbidden":
      throw new SaveNotCompleted(t("recordReadOnly"));
    case "object.invalid": {
      const details = readAdminApiError(error)?.details;
      const issues = Array.isArray(details) ? details.filter((item): item is { key: string; message: string } =>
        Boolean(item && typeof item.key === "string" && typeof item.message === "string")) : [];
      const focus = Object.fromEntries(issues.map((issue) => [issue.message, () => document.getElementById(`object-entry-${issue.key}`)?.focus()]));
      throw new SaveNotCompleted(t("fixFields"), issues.map((issue) => issue.message), focus);
    }
    case "OBJECT_TYPE_TAKEN":
      throw new SaveNotCompleted(t("typeTaken"));
    case "OBJECT_HANDLE_TAKEN":
      throw new SaveNotCompleted(t("entryHandleTaken"));
    case "OBJECT_NAMESPACE_FORBIDDEN":
      throw new SaveNotCompleted(t("typeNamespace"));
    case "OBJECT_LIMIT":
      throw new SaveNotCompleted(t(kind === "type" ? "typeLimit" : "entryLimit"));
    default:
  }
}
