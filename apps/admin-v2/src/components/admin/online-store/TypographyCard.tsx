import { useEffect, useState, type CSSProperties } from "react";
import {
  STOREFRONT_HEADING_CASES,
  STOREFRONT_TYPE_PAIRINGS,
  STOREFRONT_TYPE_SCALES,
  type StorefrontThemeDocument,
  type StorefrontTypePairing,
} from "@scalius/shared/storefront-theme";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { SectionCard } from "./shared";
import { HeadingCaseSketch, TypeScaleSketch, VisualChoice } from "./ThemeChoices";
import {
  resetTypeTokens,
  setTypeTokens,
  templateTypeTokens,
  typePairingPreview,
  typeTokensAreTemplateDefault,
} from "./theme-settings";

type Theme = StorefrontThemeDocument;
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/**
 * Script samples, not copy: the same in every dashboard language, because
 * they show how the store's Latin and Bangla text look.
 */
const SAMPLE_HEADING = "New arrivals";
const SAMPLE_BODY = "Soft cotton, cut for everyday wear.";
const SAMPLE_BANGLA = "নতুন কালেকশন, প্রতিদিনের আরামের জন্য।";

/** The families a pairing names, in words ("Instrument Serif and Inter · Bangla: Noto Serif Bengali"). */
function useFamilies() {
  const t = useMessages(onlineStoreMessages);
  return (pairing: StorefrontTypePairing) => {
    const { heading, body, bangla } = typePairingPreview(pairing);
    return heading.family === body.family
      ? t("typographyFamily", { body: body.family, bangla })
      : t("typographyFamilies", { heading: heading.family, body: body.family, bangla });
  };
}

/**
 * A pairing drawn in its own faces: the heading at its weight, a line of
 * body text and a Bangla line. The faces exist only once the picker has
 * registered them; decorative, since the option's name labels it.
 */
function PairingSample({ pairing }: { pairing: StorefrontTypePairing }) {
  const preview = typePairingPreview(pairing);
  return (
    <span
      aria-hidden="true"
      // Runtime values reach CSS only as custom properties (DESIGN.md).
      style={{
        "--type-heading": preview.heading.stack,
        "--type-heading-weight": preview.heading.weight,
        "--type-body": preview.body.stack,
      } as CSSProperties}
      className="flex flex-col gap-1 overflow-clip rounded-lg bg-muted px-3 py-2 text-foreground"
    >
      <span className="truncate font-(family-name:--type-heading) text-heading-lg">
        <span className="font-(--type-heading-weight)">{SAMPLE_HEADING}</span>
      </span>
      <span className="truncate font-(family-name:--type-body) text-body">{SAMPLE_BODY}</span>
      <span lang="bn" className="truncate font-(family-name:--type-body) text-body">{SAMPLE_BANGLA}</span>
    </span>
  );
}

/**
 * Typography, as Shopify's theme editor offers it: the current fonts with a
 * Change button that opens the list, each pairing drawn in its own
 * self-hosted faces (downloaded only once the list opens), then the heading
 * size and case. The template's own choices are marked, and one action puts
 * them back.
 */
export function TypographyCard({ theme, setDraft }: {
  theme: Theme;
  setDraft: (update: (current: Theme) => Theme) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const option = (key: string) => t(key as MessageKey);
  const families = useFamilies();
  const current = theme.tokens.typography;
  const defaults = templateTypeTokens(theme);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<StorefrontTypePairing>(current);

  // The preview faces register (and download as the list draws) only once
  // the picker opens, so the Theme page's first render stays as it was.
  useEffect(() => {
    if (!open) return;
    void import("./type-preview-fonts").then(({ registerTypePreviewFonts }) => registerTypePreviewFonts());
  }, [open]);

  const templateDefault = <Badge>{t("typographyTemplateDefault")}</Badge>;
  const openPicker = () => {
    setPending(current);
    setOpen(true);
  };

  return (
    <SectionCard
      title={t("typography")}
      description={t("typographyHelp")}
      action={typeTokensAreTemplateDefault(theme) ? null : (
        <Button type="button" variant="outline" size="sm" onClick={() => setDraft(resetTypeTokens)}>
          {t("typographyReset")}
        </Button>
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body font-medium">
            {option(`typography_${current}`)}
            {current === defaults.typography ? templateDefault : null}
          </p>
          <p className="text-body text-muted-foreground">{families(current)}</p>
        </div>
        <Button type="button" variant="outline" aria-label={t("typographyChangeLabel")} onClick={openPicker}>
          {t("typographyChange")}
        </Button>
      </div>

      <VisualChoice
        label={t("typeScale")}
        showLabel
        value={theme.tokens.typeScale}
        className="grid-cols-3"
        options={STOREFRONT_TYPE_SCALES.map((value) => ({
          value,
          label: option(`typeScale_${value}`),
          sketch: <TypeScaleSketch scale={value} />,
        }))}
        onChange={(typeScale) => setDraft((draft) => setTypeTokens(draft, { typeScale }))}
      />

      <VisualChoice
        label={t("headingCase")}
        showLabel
        value={theme.tokens.headingCase}
        className="grid-cols-2"
        options={STOREFRONT_HEADING_CASES.map((value) => ({
          value,
          label: option(`headingCase_${value}`),
          sketch: <HeadingCaseSketch headingCase={value} sample={SAMPLE_HEADING} />,
        }))}
        onChange={(headingCase) => setDraft((draft) => setTypeTokens(draft, { headingCase }))}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("typographyPick")}</DialogTitle>
            <DialogDescription>{t("typographyPickHelp")}</DialogDescription>
          </DialogHeader>
          <VisualChoice
            label={t("typographyPick")}
            value={pending}
            className="grid-cols-1 sm:grid-cols-2"
            options={STOREFRONT_TYPE_PAIRINGS.map((value) => ({
              value,
              label: option(`typography_${value}`),
              help: families(value),
              badge: value === defaults.typography ? templateDefault : undefined,
              sketch: <PairingSample pairing={value} />,
            }))}
            onChange={setPending}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
                if (pending !== current) setDraft((draft) => setTypeTokens(draft, { typography: pending }));
              }}
            >
              {t("typographySelect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
