import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";

export function OrderAttributesCard({ attributes }: { attributes?: Record<string, string> }) {
  const t = useMessages(orderDetailMessages);
  const groups = new Map<string, Array<[string, string]>>();
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const separator = key.lastIndexOf(".");
    const app = key.slice(0, separator);
    const entries = groups.get(app) ?? [];
    entries.push([key.slice(separator + 1), value]);
    groups.set(app, entries);
  }
  if (groups.size === 0) return null;

  return (
    <Card>
      <CardHeader><CardTitle>{t("attributes.title")}</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-4">
          {[...groups].map(([app, entries]) => (
            <section key={app} className="space-y-2">
              <h3 className="text-body font-medium wrap-anywhere">{app}</h3>
              <dl className="space-y-2 text-body">
                {entries.map(([key, value]) => (
                  <div key={key} className="space-y-0.5">
                    <dt className="text-muted-foreground wrap-anywhere">{key}</dt>
                    <dd className="whitespace-pre-wrap wrap-anywhere">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
