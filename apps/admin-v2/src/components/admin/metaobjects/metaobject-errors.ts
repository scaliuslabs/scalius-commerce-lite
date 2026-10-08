// A failed metaobject write as the merchant reads it, in the dashboard
// language: the API's codes become plain sentences; a refusal with a field
// list stays with the save bar, which marks the fields.
import { translate } from "~/i18n";
import { metaobjectMessages, type MetaobjectMessageKey } from "~/i18n/metaobjects";
import { readAdminApiErrorCode } from "~/lib/admin-api-error";
import { SaveConflict, SaveNotCompleted } from "~/components/admin/shared/SaveBar";

type Kind = "type" | "entry";

/**
 * Throws a `SaveConflict` (stale revision) or a `SaveNotCompleted` with a
 * translated sentence for the codes the API names; returns for any other
 * error, which the caller rethrows for the save bar to describe.
 */
export function throwMetaobjectSaveError(error: unknown, kind: Kind): void {
  const t = (key: MetaobjectMessageKey) => translate(metaobjectMessages, key);
  switch (readAdminApiErrorCode(error)) {
    case "METAOBJECT_REVISION_CONFLICT":
      throw new SaveConflict(t(kind === "type" ? "typeChanged" : "entryChanged"));
    case "METAOBJECT_TYPE_TAKEN":
      throw new SaveNotCompleted(t("typeTaken"));
    case "METAOBJECT_HANDLE_TAKEN":
      throw new SaveNotCompleted(t("entryHandleTaken"));
    case "METAOBJECT_NAMESPACE_FORBIDDEN":
      throw new SaveNotCompleted(t("typeNamespace"));
    case "METAOBJECT_LIMIT":
      throw new SaveNotCompleted(t(kind === "type" ? "typeLimit" : "entryLimit"));
    default:
  }
}
