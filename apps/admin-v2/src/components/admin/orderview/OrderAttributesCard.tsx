import { lineEntryWords } from "@scalius/shared/line-entry-words";
import { presentCheckoutAttributes, type CheckoutAttributeApp } from "@scalius/shared/plugins/checkout-attribute-text";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useLocale, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { getStoreRegion } from "~/lib/store-time-zone";
import { BuyerFiles } from "./BuyerFiles";

/**
 * The apps' checkout answers on an order, in the staff member's language:
 * each app by its name, each answer under the app's label for it, a choice by
 * its label, a date and a number in the dashboard's format
 * (`presentCheckoutAttributes`). An app the store no longer has keeps its id
 * and its keys.
 */
export function OrderAttributesCard({ attributes, apps = [] }: { attributes?: Record<string, string>; apps?: readonly CheckoutAttributeApp[] }) {
  const t = useMessages(orderDetailMessages);
  const locale = useLocale();
  const groups = presentCheckoutAttributes(attributes ?? {}, apps, { locale, defaultLocale: locale, words: lineEntryWords(locale), region: getStoreRegion() });
  if (groups.length === 0) return null;

  return (
    <Card>
      <CardHeader><CardTitle>{t("attributes.title")}</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.appId} className="space-y-2">
              <h3 className="text-body font-medium wrap-anywhere">{group.appName}</h3>
              <dl className="space-y-2 text-body">
                {group.entries.map((entry) => (
                  <div key={entry.key} className="space-y-0.5">
                    <dt className="text-muted-foreground wrap-anywhere">{entry.label}</dt>
                    <dd className="whitespace-pre-wrap wrap-anywhere">
                      {entry.uploads ? <BuyerFiles value={entry.uploads} /> : entry.value}
                    </dd>
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
