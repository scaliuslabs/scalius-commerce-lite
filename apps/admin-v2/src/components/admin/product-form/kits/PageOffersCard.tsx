import { useEffect, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { patchApiV1AdminProductsByIdSectionsBySection } from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";
import { useCommand } from "~/lib/use-command";
import { getServerFnError } from "~/lib/api-helpers";
import { readProductRevisionConflict } from "~/lib/admin-api-conflicts";
import { useCurrency } from "~/hooks/use-currency";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { SortableList } from "~/components/admin/shared/SortableList";
import { OWN_SAVE_ATTRIBUTE } from "~/components/admin/shared/SaveBar";
import { useMessages } from "~/i18n";
import { productKitMessages } from "~/i18n/product-kits";
import { readProductKitRefusal } from "~/i18n/product-kit-refusals";
import { resourceMessages } from "~/i18n/resource";
import { CollapsibleCard } from "../CollapsibleCard";
import { productPageOffersQueryOptions, type ProductPageOffer } from "../merchandising/section-api";
import { SkuPickerDialog, skuName, type SkuOption } from "./SkuPickerDialog";
import type { ProductRevisionHandle } from "./kit-types";

const PAGE_OFFERS_MAX = 20;
const quiet = () => undefined;
/** dnd-kit's own (English) drag announcements: the card announces moves itself. */
const SILENT = { onDragStart: quiet, onDragMove: quiet, onDragOver: quiet, onDragEnd: quiet, onDragCancel: quiet };

type Offer = ProductPageOffer & { id: string };

const withId = (offer: ProductPageOffer): Offer => ({ ...offer, id: offer.variantId });

const fromOption = (option: SkuOption): Offer => ({
  id: option.variantId,
  variantId: option.variantId,
  productId: option.productId,
  productName: option.productName,
  sku: option.sku,
  options: option.options,
  position: 0,
  isKit: option.isKit,
  price: option.price,
  problem: option.productActive ? null : "component_inactive",
});

/**
 * SKUs of other products shown under this product's own offers, in order:
 * add through the SKU picker, reorder by the handle (drag, or Space, the
 * arrows, Space), remove. Each change saves at once under the product's
 * revision and is announced; a refused change is undone and its reason shown.
 */
export default function PageOffersCard({ productId, readOnly, revision }: {
  productId: string;
  readOnly: boolean;
  revision: ProductRevisionHandle;
}) {
  const t = useMessages(productKitMessages);
  const tr = useMessages(resourceMessages);
  const { fmt } = useCurrency();
  const queryClient = useQueryClient();
  const { data, isError, refetch } = useQuery(productPageOffersQueryOptions(productId));
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  // Keyboard move: the offer lifted and the order it started from (Escape puts it back).
  const [grabbed, setGrabbed] = useState<{ id: string; before: Offer[] } | null>(null);
  const [writing, setWriting] = useState(false);

  // The saved list replaces the shown one unless a change is on its way or an offer is lifted.
  useEffect(() => {
    if (data && !writing && !grabbed) setOffers(data.items.map(withId));
  }, [data, grabbed, writing]);

  const write = useCommand<{ id: string; variantIds: string[] }, { aggregateRevision: number }>({
    mutationFn: ({ variantIds }) => {
      const expectedAggregateRevision = revision.current();
      if (!expectedAggregateRevision) throw new Error(t("saveFailed"));
      return apiData(patchApiV1AdminProductsByIdSectionsBySection({
        path: { id: productId, section: "page_offers" },
        body: { section: "page_offers", expectedAggregateRevision, variantIds },
      }));
    },
    onSuccess: async (result) => {
      revision.saved(result.aggregateRevision);
      await queryClient.invalidateQueries({ queryKey: productPageOffersQueryOptions(productId).queryKey });
    },
  });

  const shown = offers ?? [];
  const nameOf = (offer: Pick<Offer, "productName" | "options" | "sku">) => skuName(offer, offer.sku ?? t("unknownItem"));

  /** Shows `next` at once and saves it; a refusal puts `previous` back and says why. */
  const commit = (next: Offer[], previous: Offer[], said: string) => {
    // One change at a time: a change made while the last one saves would not be sent.
    if (write.isPending) {
      setOffers(previous);
      return;
    }
    setOffers(next);
    setRefusal(null);
    setWriting(true);
    write.mutate({ id: productId, variantIds: next.map((offer) => offer.variantId) }, {
      onSuccess: () => setAnnouncement(said),
      onError: (error) => {
        setOffers(previous);
        const conflict = readProductRevisionConflict(error);
        if (conflict) revision.conflict(conflict);
        const kitRefusal = readProductKitRefusal(error);
        setRefusal(conflict ? t("changedElsewhere") : kitRefusal?.message ?? getServerFnError(error, t("saveFailed")));
      },
      onSettled: () => setWriting(false),
    });
  };

  const add = (options: SkuOption[]) => {
    const next = [...shown, ...options.filter((option) => !shown.some((offer) => offer.variantId === option.variantId)).map(fromOption)];
    commit(next, shown, t("offersAdded", { count: next.length - shown.length }));
  };
  const remove = (offer: Offer) => commit(shown.filter((entry) => entry.id !== offer.id), shown, t("offerRemoved", { name: nameOf(offer) }));
  const moved = (next: Offer[], offer: Offer) =>
    t("dropped", { name: nameOf(offer), position: next.findIndex((entry) => entry.id === offer.id) + 1, count: next.length });

  const onHandleKey = (event: KeyboardEvent, offer: Offer) => {
    const index = shown.findIndex((entry) => entry.id === offer.id);
    const position = (list: Offer[]) => list.findIndex((entry) => entry.id === offer.id) + 1;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (!grabbed) {
        if (write.isPending) return;
        setGrabbed({ id: offer.id, before: shown });
        setAnnouncement(t("pickedUp", { name: nameOf(offer), position: index + 1, count: shown.length }));
        return;
      }
      const before = grabbed.before;
      setGrabbed(null);
      if (before.map((entry) => entry.id).join() === shown.map((entry) => entry.id).join()) {
        setAnnouncement(moved(shown, offer));
        return;
      }
      commit(shown, before, moved(shown, offer));
      return;
    }
    if (!grabbed || grabbed.id !== offer.id) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const target = index + (event.key === "ArrowUp" ? -1 : 1);
      if (target < 0 || target >= shown.length) return;
      const next = [...shown];
      next.splice(index, 1);
      next.splice(target, 0, offer);
      setOffers(next);
      setAnnouncement(t("movedTo", { name: nameOf(offer), position: position(next), count: next.length }));
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOffers(grabbed.before);
      setGrabbed(null);
      setAnnouncement(t("moveCancelled", { name: nameOf(offer), position: position(grabbed.before) }));
    }
  };

  const row = (offer: Offer) => (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <p className="flex flex-wrap items-center gap-2 text-body">
        <span className="font-medium wrap-anywhere">{nameOf(offer)}</span>
        {offer.isKit ? <Badge variant="info">{t("bundle")}</Badge> : null}
      </p>
      <p className="text-body text-muted-foreground">
        {offer.sku ? <span className="font-mono">{offer.sku}</span> : null}
        {offer.sku && offer.price !== null ? " · " : null}
        {offer.price === null ? null : <span className="tabular-nums">{fmt(offer.price)}</span>}
      </p>
      {offer.problem ? (
        <p className="text-body text-destructive">
          {t("offerHidden")}{t(`problem_${offer.problem}`, { name: nameOf(offer) })}
        </p>
      ) : null}
    </div>
  );

  return (
    <CollapsibleCard
      id="product-page-offers"
      title={t("offersTitle")}
      description={t("offersHelp")}
      defaultOpen={(data?.items.length ?? 0) > 0}
      summary={data === undefined ? null : <p className="text-body text-muted-foreground">{t("offersSummary", { count: data.items.length })}</p>}
    >
      <div {...{ [OWN_SAVE_ATTRIBUTE]: "" }} className="flex flex-col gap-3">
        {offers === null ? (
          isError ? (
            <p className="text-body text-muted-foreground">
              {t("offersLoadFailed")}{" "}
              <Button type="button" variant="link" onClick={() => void refetch()}>{tr("retry")}</Button>
            </p>
          ) : <Skeleton className="h-16 w-full" />
        ) : shown.length === 0 ? (
          <p className="text-body text-muted-foreground">{t("noOffers")}</p>
        ) : readOnly ? (
          <ol className="flex flex-col divide-y">
            {shown.map((offer) => <li key={offer.id} className="py-2 first:pt-0">{row(offer)}</li>)}
          </ol>
        ) : (
          <>
            <SortableList
              items={shown}
              // The handle's instructions in the dashboard's language; moves are announced below.
              accessibility={{ screenReaderInstructions: { draggable: t("moveHelp") }, announcements: SILENT }}
              onReorder={(next) => {
                const offer = next.find((entry, index) => entry.id !== shown[index]?.id);
                if (offer) commit(next, shown, moved(next, offer));
              }}
              renderItem={(offer, { ref, style, dragHandleProps, isDragging }) => (
                <div ref={ref} style={style} data-dragging={isDragging || grabbed?.id === offer.id || undefined} className="flex items-start gap-2 rounded-lg border p-2 data-dragging:bg-accent">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    {...dragHandleProps}
                    aria-label={t("moveOffer", { name: nameOf(offer) })}
                    aria-pressed={grabbed?.id === offer.id}
                    onKeyDown={(event: KeyboardEvent) => onHandleKey(event, offer)}
                    className="cursor-grab touch-none"
                  >
                    <GripVertical className="size-4" aria-hidden="true" />
                  </Button>
                  {row(offer)}
                  <Button type="button" variant="ghost" size="icon" aria-label={t("removeOffer", { name: nameOf(offer) })} disabled={write.isPending} onClick={() => remove(offer)}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              )}
            />
          </>
        )}
        {refusal ? <p role="alert" className="text-body text-destructive">{refusal}</p> : null}
        {readOnly || offers === null ? null : (
          <div>
            <Button type="button" variant="outline" loading={write.isPending} disabled={shown.length >= PAGE_OFFERS_MAX} onClick={() => setPicking(true)}>
              <Plus className="size-4" aria-hidden="true" />
              {t("addOffers")}
            </Button>
          </div>
        )}
        <p className="sr-only" aria-live="polite">{announcement}</p>
      </div>
      {readOnly ? null : (
        <SkuPickerDialog
          open={picking}
          onOpenChange={setPicking}
          mode="offers"
          productId={productId}
          chosenIds={new Set(shown.map((offer) => offer.variantId))}
          capacity={PAGE_OFFERS_MAX - shown.length}
          onAdd={add}
        />
      )}
    </CollapsibleCard>
  );
}
