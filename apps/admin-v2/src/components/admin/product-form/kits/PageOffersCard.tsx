import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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
interface PageOffersCardProps {
  productId: string;
  /** How many offers the product read counted: the closed card says it without its own read. */
  count: number;
  readOnly: boolean;
  /** The page's own save is on its way: a change waits for it, then saves. */
  pageSaving: boolean;
  revision: ProductRevisionHandle;
}

export default function PageOffersCard({ productId, count, readOnly, pageSaving, revision }: PageOffersCardProps) {
  const t = useMessages(productKitMessages);
  // The list's own count once it has been opened and changed.
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const shownCount = liveCount ?? count;
  return (
    <CollapsibleCard
      id="product-page-offers"
      title={t("offersTitle")}
      description={t("offersHelp")}
      defaultOpen={count > 0}
      summary={<p className="text-body text-muted-foreground">{t("offersSummary", { count: shownCount })}</p>}
    >
      <PageOffersBody productId={productId} readOnly={readOnly} pageSaving={pageSaving} revision={revision} onCount={setLiveCount} />
    </CollapsibleCard>
  );
}

/** The list itself: read once the card opens. */
function PageOffersBody({ productId, readOnly, pageSaving, revision, onCount }: Omit<PageOffersCardProps, "count"> & { onCount: (count: number) => void }) {
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
  // One write at a time: a change made meanwhile (or while the page saves) is shown at once and sent next.
  const inFlight = useRef(false);
  const pageSavingNow = useRef(pageSaving);
  pageSavingNow.current = pageSaving;
  const queued = useRef<{ next: Offer[]; said: string } | null>(null);
  // The order the server last accepted: what a refused change returns to.
  const accepted = useRef<Offer[]>([]);

  // The saved list replaces the shown one unless a change is on its way or an offer is lifted.
  useEffect(() => {
    if (!data || writing || grabbed || queued.current) return;
    const items = data.items.map(withId);
    accepted.current = items;
    setOffers(items);
    onCount(items.length);
  }, [data, grabbed, writing, onCount]);

  const write = useCommand<{ id: string; variantIds: string[] }, { aggregateRevision: number }>({
    onMutate: () => revision.writing(true),
    onSettled: () => revision.writing(false),
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

  /** Shows `next` at once and saves it (after the write or page save on its way); a refusal returns to the last accepted order and says why. */
  const commit = (next: Offer[], said: string) => {
    setOffers(next);
    setRefusal(null);
    if (inFlight.current || pageSavingNow.current) {
      queued.current = { next, said };
      return;
    }
    send(next, said);
  };
  const send = (next: Offer[], said: string) => {
    inFlight.current = true;
    setWriting(true);
    write.mutate({ id: productId, variantIds: next.map((offer) => offer.variantId) }, {
      onSuccess: () => {
        accepted.current = next;
        onCount(next.length);
        setAnnouncement(said);
      },
      onError: (error) => {
        // A change queued on top of the refused one is dropped with it.
        queued.current = null;
        setOffers(accepted.current);
        const conflict = readProductRevisionConflict(error);
        if (conflict) revision.conflict(conflict);
        const kitRefusal = readProductKitRefusal(error);
        const reason = conflict ? t("changedElsewhere") : kitRefusal?.message ?? getServerFnError(error, t("saveFailed"));
        setRefusal(reason);
        setAnnouncement(reason);
      },
      onSettled: () => {
        inFlight.current = false;
        const pending = queued.current;
        queued.current = null;
        if (pending && !pageSavingNow.current) send(pending.next, pending.said);
        else {
          if (pending) queued.current = pending;
          setWriting(false);
        }
      },
    });
  };
  // A change made while the page saved goes once that save is done.
  useEffect(() => {
    if (pageSaving || inFlight.current || !queued.current) return;
    const pending = queued.current;
    queued.current = null;
    send(pending.next, pending.said);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSaving]);

  const add = (options: SkuOption[]) => {
    const next = [...shown, ...options.filter((option) => !shown.some((offer) => offer.variantId === option.variantId)).map(fromOption)];
    commit(next, t("offersAdded", { count: next.length - shown.length }));
  };
  const remove = (offer: Offer) => commit(shown.filter((entry) => entry.id !== offer.id), t("offerRemoved", { name: nameOf(offer) }));
  const moved = (next: Offer[], offer: Offer) =>
    t("dropped", { name: nameOf(offer), position: next.findIndex((entry) => entry.id === offer.id) + 1, count: next.length });

  const onHandleKey = (event: KeyboardEvent, offer: Offer) => {
    const index = shown.findIndex((entry) => entry.id === offer.id);
    const position = (list: Offer[]) => list.findIndex((entry) => entry.id === offer.id) + 1;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (!grabbed) {
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
      commit(shown, moved(shown, offer));
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
      cancelMove(offer);
    }
  };
  /** Puts a lifted offer back where it was (Escape, or the keyboard leaving it), saying so. */
  const cancelMove = (offer: Offer) => {
    const lifted = grabbedNow.current;
    if (!lifted || lifted.id !== offer.id) return;
    setOffers(lifted.before);
    setGrabbed(null);
    setAnnouncement(t("moveCancelled", { name: nameOf(offer), position: lifted.before.findIndex((entry) => entry.id === offer.id) + 1 }));
  };
  // A lifted offer keeps the keyboard as it moves (moving its row may drop focus on the way).
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const grabbedNow = useRef(grabbed);
  grabbedNow.current = grabbed;
  useLayoutEffect(() => {
    if (!grabbed) return;
    const handle = handles.current.get(grabbed.id);
    if (handle && document.activeElement !== handle) handle.focus();
  }, [grabbed, offers]);
  /** Focus leaving a lifted offer (not its own move) puts it back. */
  const onHandleBlur = (offer: Offer) => {
    setTimeout(() => {
      if (grabbedNow.current?.id === offer.id && document.activeElement !== handles.current.get(offer.id)) cancelMove(offer);
    }, 0);
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
    <>
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
                if (offer) commit(next, moved(next, offer));
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
                    ref={(node: HTMLButtonElement | null) => {
                      if (node) handles.current.set(offer.id, node);
                      else handles.current.delete(offer.id);
                    }}
                    // The keyboard leaving a lifted offer puts it back: never a reordered list left unsaved.
                    onBlur={() => onHandleBlur(offer)}
                    className="cursor-grab touch-none"
                  >
                    <GripVertical className="size-4" aria-hidden="true" />
                  </Button>
                  {row(offer)}
                  <Button type="button" variant="ghost" size="icon" aria-label={t("removeOffer", { name: nameOf(offer) })} onClick={() => remove(offer)}>
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
            <Button type="button" variant="outline" disabled={shown.length >= PAGE_OFFERS_MAX} onClick={() => setPicking(true)}>
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
    </>
  );
}
