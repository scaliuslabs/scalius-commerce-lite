import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";

export function OrderNotesCard({ notes }: { notes: string }) {
  const t = useMessages(orderDetailMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("notes.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-body text-muted-foreground">{notes}</p>
      </CardContent>
    </Card>
  );
}
