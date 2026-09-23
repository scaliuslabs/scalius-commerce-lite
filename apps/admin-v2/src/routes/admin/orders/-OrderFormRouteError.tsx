import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { resourceMessages } from "~/i18n/resource";

/** Create/Edit order load failure: server message, Try again, Back to orders. */
export function OrderFormRouteError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useMessages(orderFormMessages);
  const r = useMessages(resourceMessages);
  return (
    <Card role="alert">
      <CardHeader>
        <CardTitle>{t("loadFailed")}</CardTitle>
        {error.message ? <CardDescription>{error.message}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button type="button" onClick={reset}>
          {r("retry")}
        </Button>
        <Button asChild variant="outline">
          <Link to="/admin/orders">{t("backToOrders")}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
