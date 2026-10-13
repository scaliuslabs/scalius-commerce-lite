import { lazy, Suspense, useEffect, useState } from "react";
import { STOREFRONT_LANDING_TITLE_MAX, storefrontLandingSlugSchema } from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Field } from "~/components/ui/field";
import { Badge } from "~/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { Theme } from "../theme-fields";
import type { LandingPreset } from "./landing-presets";

const ProductSelect = lazy(() => import("../schema-form/resource-fields").then((module) => ({ default: module.ProductSelect })));
const BLANK = "blank";

function landingHandle(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

/** Naming a new landing page: its title and the handle in its address. */
export function CreateLandingDialogContent({ open, theme, presets = [], onCreate, onCloseAutoFocus }: {
  open: boolean;
  theme: Theme;
  /** Ready-made pages installed apps offer; the page may start from one. */
  presets?: readonly LandingPreset[];
  onCreate: (slug: string, title: string, start: { preset: LandingPreset; productId: string | null } | null) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [presetKey, setPresetKey] = useState(BLANK);
  const [productId, setProductId] = useState("");
  useEffect(() => {
    if (!open) { setTitle(""); setSlug(""); setSlugEdited(false); setPresetKey(BLANK); setProductId(""); }
  }, [open]);
  const handle = slugEdited ? slug : landingHandle(title);
  const taken = Boolean(theme.pages.landing[handle]);
  const handleValid = storefrontLandingSlugSchema.safeParse(handle).success && !taken;
  const preset = presets.find((each) => each.key === presetKey) ?? null;
  const valid = handleValid && title.trim().length > 0 && (!preset?.needsProduct || productId !== "");
  return (
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("newLanding")}</DialogTitle>
          <DialogDescription>{t("newLandingHelp")}</DialogDescription>
        </DialogHeader>
        <form
          id="new-landing-form"
          method="post"
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onCreate(handle, title.trim(), preset ? { preset, productId: productId || null } : null);
          }}
        >
          <Field id="new-landing-title" label={t("landingTitle")}>
            <Input id="new-landing-title" value={title} maxLength={STOREFRONT_LANDING_TITLE_MAX} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </Field>
          <Field id="new-landing-slug" label={t("landingSlug")}>
            <Input
              id="new-landing-slug"
              value={handle}
              maxLength={100}
              aria-invalid={handle !== "" && !handleValid}
              aria-describedby="landing-slug-help"
              onChange={(event) => { setSlugEdited(true); setSlug(event.target.value); }}
            />
            <p id="landing-slug-help" className={handle !== "" && !handleValid ? "text-body text-destructive" : "text-body text-muted-foreground"}>
              {handle !== "" && !handleValid ? t(taken ? "landingSlugTaken" : "landingSlugInvalid") : t("landingSlugHelp", { path: `/pages/${handle || "…"}` })}
            </p>
          </Field>
          {presets.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-body font-medium">{t("landingStart")}</legend>
              <RadioGroup value={presetKey} onValueChange={setPresetKey}>
                {[
                  { value: BLANK, label: t("landingBlank"), help: t("landingBlankHelp"), app: null },
                  ...presets.map((each) => ({ value: each.key, label: each.name, help: each.description, app: each.appName })),
                ].map((option) => (
                  <label key={option.value} className="flex min-h-11 items-start gap-3 rounded-md px-2 py-1.5 text-body hover:bg-muted">
                    <span className="flex h-lh items-center"><RadioGroupItem value={option.value} /></span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {option.label}
                        {option.app ? <Badge variant="secondary">{t("appBadge")}</Badge> : null}
                      </span>
                      {option.help || option.app ? (
                        <span className="block text-muted-foreground">
                          {[option.help, option.app ? t("appFrom", { app: option.app }) : null].filter(Boolean).join(" ")}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
          ) : null}
          {preset?.needsProduct ? (
            <Field id="new-landing-product" label={t("landingProduct")}>
              <Suspense fallback={<Input id="new-landing-product" disabled aria-busy="true" />}>
                <ProductSelect id="new-landing-product" value={productId} onChange={setProductId} />
              </Suspense>
              <p className="text-body text-muted-foreground">{t("landingProductHelp")}</p>
            </Field>
          ) : null}
        </form>
        <DialogFooter>
          <Button type="submit" form="new-landing-form" disabled={!valid}>{t("addLanding")}</Button>
        </DialogFooter>
      </DialogContent>
  );
}
