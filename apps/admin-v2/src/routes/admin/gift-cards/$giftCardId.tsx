import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { GiftCardDetail } from "~/components/admin/gift-cards/GiftCardDetail";
import { translate } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { titleHead } from "~/i18n/page-titles";
import { giftCardQueryOptions } from "~/lib/api-query-options/gift-cards";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/gift-cards/$giftCardId")({
  loader: ({ context: { queryClient }, params }) => queryClient.ensureQueryData(giftCardQueryOptions(params.giftCardId)),
  head: () => titleHead(translate(shellMessages, "giftCards")),
  errorComponent: RouteErrorComponent,
  component: GiftCardPage,
});

function GiftCardPage() {
  const { giftCardId } = Route.useParams();
  const { data } = useSuspenseQuery(giftCardQueryOptions(giftCardId));
  return <GiftCardDetail key={data.giftCard.id} card={data.giftCard} transactions={data.transactions} />;
}
