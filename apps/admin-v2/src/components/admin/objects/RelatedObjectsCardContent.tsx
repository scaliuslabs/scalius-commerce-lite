import { Link } from "@tanstack/react-router";
import type { RelatedObjectRecord } from "@scalius/shared/plugins/objects";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { objectMessages } from "~/i18n/objects";

/** The resource detail carries this bounded projection in its existing read. */
export function RelatedObjectsCardContent({ records }: { records: readonly RelatedObjectRecord[] }) {
  const t = useMessages(objectMessages);
  return (
    <Card>
      <CardHeader><CardTitle>{t("relatedTitle")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {records.map((record) => (
            <li key={`${record.typeId}:${record.recordId}`}>
              <Link
                to="/admin/objects/$type/records/$recordId"
                params={{ type: record.typeHandle, recordId: record.recordId }}
                className="text-body text-link hover:underline"
              >{record.displayName}</Link>
              <p className="text-body text-muted-foreground">{record.typeName}</p>
            </li>
          ))}
        </ul>
        {records.length === 25 ? <p className="text-body text-muted-foreground">{t("relatedLimit", { count: 25 })}</p> : null}
      </CardContent>
    </Card>
  );
}
