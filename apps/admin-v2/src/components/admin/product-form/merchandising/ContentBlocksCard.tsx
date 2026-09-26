import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from "lucide-react";
import {
  PRODUCT_CONTENT_BLOCK_PLACEMENTS,
  PRODUCT_CONTENT_BLOCK_REGISTRY,
  PRODUCT_CONTENT_BLOCK_TYPES,
  PRODUCT_CONTENT_BLOCKS_MAX,
  isProductContentBlockPlacementAllowed,
  isProductContentBlockType,
  parseProductContentBlock,
  productContentBlockDefault,
  type ProductContentBlockPlacement,
  type ProductContentBlockType,
} from "@scalius/shared/product-content-blocks";
import { cn } from "@scalius/shared/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { productMerchandisingMessages } from "~/i18n/product-merchandising";
import { CollapsibleCard } from "../CollapsibleCard";
import { BlockSettingsEditor, type BlockMediaPreview } from "./block-editors";
import { productContentBlocksQueryOptions, saveProductSection, type ContentBlockItem } from "./section-api";
import { useProductSection } from "./product-sections";
import { useSectionDraft } from "./use-section-draft";

interface BlockDraft {
  key: string;
  /** The saved block's id; a tab from the old Additional sections has none here (it is saved anew). */
  id: string | null;
  /** A tab mirrored from Additional sections: saved as a new block, and the old tab removed. */
  legacy: boolean;
  placement: ProductContentBlockPlacement;
  type: string;
  version: number;
  settings: Record<string, unknown>;
}

type Draft = { blocks: BlockDraft[] };
type BlockType = ProductContentBlockType;

function fromItem(item: ContentBlockItem): BlockDraft {
  return {
    key: item.id,
    id: item.legacy ? null : item.id,
    legacy: item.legacy,
    placement: item.placement,
    type: item.type,
    version: item.version,
    settings: item.settings ?? {},
  };
}

/** A short name for the block in its row: its title or heading, else its type. */
function blockTitle(block: BlockDraft): string {
  const settings = block.settings;
  for (const key of ["title", "heading", "text", "label"]) {
    const value = settings[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * The product page's content: tabs (size guide, care) and sections (image
 * with text, FAQ, video, comparison…), in page order per placement. It
 * replaces the old Additional sections editor: its tabs appear here and are
 * saved as blocks the first time the content is saved.
 */
export default function ContentBlocksCard({ productId, readOnly, onTabsMoved }: {
  productId: string;
  readOnly: boolean;
  /** The old tabs were saved as blocks: the product save removes them from Additional sections. */
  onTabsMoved: () => void;
}) {
  const t = useMessages(productMerchandisingMessages);
  const queryClient = useQueryClient();
  const { data } = useQuery(productContentBlocksQueryOptions(productId));
  const loaded = useMemo<Draft | undefined>(() => (data ? { blocks: data.items.map(fromItem) } : undefined), [data]);
  const { draft, setDraft, saved, dirty, markSaved, prepareRebase } = useSectionDraft(loaded);
  const blocks = useMemo(() => draft?.blocks ?? [], [draft]);
  const [open, setOpen] = useState<string | null>(null);
  const [chosenMedia, setChosenMedia] = useState<BlockMediaPreview[]>([]);
  const media = useMemo(() => new Map<string, BlockMediaPreview>(
    [...(data?.media ?? []), ...chosenMedia].map((file) => [file.id, file]),
  ), [data, chosenMedia]);

  const typeLabel = (type: string) => (isProductContentBlockType(type) ? t(`type_${type}` as never) : type);

  const problems = useMemo(() => {
    const lines: string[] = [];
    blocks.forEach((block, index) => {
      const parsed = parseProductContentBlock({ type: block.type, version: block.version, settings: block.settings });
      if (!parsed.success) {
        lines.push(t("blockProblem", { number: index + 1, type: typeLabel(block.type), problem: parsed.error }));
      }
    });
    return lines.length > 0 ? lines : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, t]);

  useProductSection({
    label: t("content"),
    dirty: !readOnly && dirty,
    problems,
    prepareRebase: async () => {
      const latest = await queryClient.fetchQuery(productContentBlocksQueryOptions(productId));
      return () => prepareRebase({ blocks: latest.items.map(fromItem) });
    },
    save: async (revision) => {
      const sent = blocks;
      const before = new Map((saved?.blocks ?? []).map((block) => [block.key, block]));
      const hadLegacy = (saved?.blocks ?? []).some((block) => block.legacy);
      const next = await saveProductSection(productId, {
        section: "content_blocks",
        expectedAggregateRevision: revision,
        blocks: sent.map((block) => {
          const stored = block.id ? before.get(block.key) : undefined;
          // A saved block whose settings didn't change is kept as stored (moved without resending it).
          if (block.id && stored && JSON.stringify(stored.settings) === JSON.stringify(block.settings)) {
            return { id: block.id, placement: block.placement, keep: true as const };
          }
          return {
            ...(block.id ? { id: block.id } : {}),
            placement: block.placement,
            type: block.type,
            version: block.version,
            settings: block.settings,
          };
        }),
      });
      // The old tabs now live as blocks; the product save removes the originals.
      if (hadLegacy) onTabsMoved();
      markSaved({ blocks: sent });
      void queryClient.invalidateQueries({ queryKey: productContentBlocksQueryOptions(productId).queryKey });
      return next;
    },
  });

  const update = (key: string, patch: Partial<BlockDraft>) =>
    setDraft({ blocks: blocks.map((block) => (block.key === key ? { ...block, ...patch } : block)) });

  const add = (type: BlockType) => {
    const value = productContentBlockDefault(type);
    const placement = PRODUCT_CONTENT_BLOCK_REGISTRY[type].placements[0]!;
    const key = `new-${nanoid(8)}`;
    // A new block goes last in its placement.
    const lastInPlacement = blocks.map((block) => block.placement).lastIndexOf(placement);
    const at = lastInPlacement === -1 ? blocks.length : lastInPlacement + 1;
    const block: BlockDraft = {
      key,
      id: null,
      legacy: false,
      placement,
      type,
      version: value.version,
      settings: value.settings as Record<string, unknown>,
    };
    setDraft({ blocks: [...blocks.slice(0, at), block, ...blocks.slice(at)] });
    setOpen(key);
  };

  /** Moves a block one place up or down within its placement. */
  const move = (key: string, step: -1 | 1) => {
    const index = blocks.findIndex((block) => block.key === key);
    const block = blocks[index];
    if (!block) return;
    let target = index + step;
    while (blocks[target] && blocks[target]!.placement !== block.placement) target += step;
    if (!blocks[target]) return;
    const next = [...blocks];
    next[index] = blocks[target]!;
    next[target] = block;
    setDraft({ blocks: next });
  };

  const changePlacement = (key: string, placement: ProductContentBlockPlacement) => {
    const block = blocks.find((item) => item.key === key);
    if (!block) return;
    const rest = blocks.filter((item) => item.key !== key);
    const lastInPlacement = rest.map((item) => item.placement).lastIndexOf(placement);
    const at = lastInPlacement === -1 ? rest.length : lastInPlacement + 1;
    setDraft({ blocks: [...rest.slice(0, at), { ...block, placement }, ...rest.slice(at)] });
  };

  const groups = PRODUCT_CONTENT_BLOCK_PLACEMENTS
    .map((placement) => ({ placement, items: blocks.filter((block) => block.placement === placement) }))
    .filter((group) => group.items.length > 0);

  return (
    <CollapsibleCard
      title={t("content")}
      description={t("contentHelp")}
      defaultOpen={readOnly}
      summary={draft === undefined ? <Skeleton className="h-5 w-40" /> : (
        <p className="text-body text-muted-foreground">
          {blocks.length > 0 ? t("blockCount", { count: blocks.length }) : t("noBlocks")}
        </p>
      )}
    >
      {draft === undefined ? <Skeleton className="h-24 w-full" /> : (
        <div className="space-y-4">
          {groups.length === 0 ? <p className="text-body text-muted-foreground">{t("noBlocks")}</p> : null}
          {groups.map((group) => (
            <section key={group.placement} className="space-y-2" aria-label={t(`placement_${group.placement}`)}>
              <h3 className="text-heading-sm font-semibold">{t(`placement_${group.placement}`)}</h3>
              <ul className="divide-y rounded-lg border">
                {group.items.map((block, index) => {
                  const expanded = open === block.key;
                  const title = blockTitle(block);
                  const known = isProductContentBlockType(block.type);
                  return (
                    <li key={block.key} className="space-y-3 p-3">
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-expanded={expanded}
                          aria-label={t("editBlock", { name: title || typeLabel(block.type) })}
                          onClick={() => setOpen(expanded ? null : block.key)}
                        >
                          <ChevronDown className={cn("h-4 w-4", !expanded && "-rotate-90")} />
                        </Button>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-body font-medium">{title || typeLabel(block.type)}</p>
                          {title ? <p className="truncate text-body text-muted-foreground">{typeLabel(block.type)}</p> : null}
                        </div>
                        {readOnly ? null : (
                          <>
                            <Button type="button" variant="ghost" size="icon" disabled={index === 0} aria-label={t("moveUp")} onClick={() => move(block.key, -1)}>
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" disabled={index === group.items.length - 1} aria-label={t("moveDown")} onClick={() => move(block.key, 1)}>
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t("removeBlock", { name: title || typeLabel(block.type) })}
                              onClick={() => setDraft({ blocks: blocks.filter((item) => item.key !== block.key) })}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                      {expanded && known ? (
                        <div className="space-y-3 border-t pt-3">
                          <div className="space-y-1">
                            <label htmlFor={`placement-${block.key}`} className="text-body font-medium">{t("placement")}</label>
                            <SearchableSelect
                              id={`placement-${block.key}`}
                              value={block.placement}
                              disabled={readOnly}
                              onValueChange={(value) => changePlacement(block.key, value as ProductContentBlockPlacement)}
                              triggerClassName="w-full"
                              options={PRODUCT_CONTENT_BLOCK_PLACEMENTS.filter((placement) => isProductContentBlockPlacementAllowed(block.type as BlockType, placement)).map((placement) => ({ value: placement, label: t(`placement_${placement}`) }))}
                            />
                          </div>
                          <BlockSettingsEditor
                            type={block.type as BlockType}
                            settings={block.settings}
                            media={media}
                            disabled={readOnly}
                            onMediaChosen={(files) => setChosenMedia((current) => [...current, ...files])}
                            onChange={(settings) => update(block.key, { settings })}
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {readOnly || blocks.length >= PRODUCT_CONTENT_BLOCKS_MAX ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline">
                  <Plus className="h-4 w-4" />
                  {t("addBlock")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {PRODUCT_CONTENT_BLOCK_TYPES.map((type) => (
                  <DropdownMenuItem key={type} onSelect={() => add(type)}>
                    {t(`type_${type}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </CollapsibleCard>
  );
}
