// An option value's swatch editor (loaded only when the merchant opens it,
// so product routes stay within their bundle budget): a colour, picked or
// typed as #rrggbb, and/or an image from Files. The storefront's swatch
// layout draws the image if there is one, else the colour; a value without
// a swatch shows its word.
import React, { type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MediaManager } from "@/components/admin/media-manager/LazyMediaManager";
import { useMessages } from "~/i18n";
import { productVariantMessages } from "~/i18n/product-variants";
import type { DraftSwatch } from "./option-matrix-editor-model";

const HEX = /^#[0-9a-f]{6}$/;

export default function OptionSwatchPicker({ value, swatch, onChange }: {
  /** The option value the swatch is for (its word). */
  value: string;
  swatch: DraftSwatch | null;
  onChange: (swatch: DraftSwatch | null) => void;
}) {
  const t = useMessages(productVariantMessages);
  const id = React.useId();
  const [text, setText] = React.useState(swatch?.color ?? "");
  const invalid = text.trim() !== "" && !HEX.test(text.trim().toLowerCase());
  const current: DraftSwatch = swatch ?? { color: null, mediaId: null, imageUrl: null };
  // A swatch with neither part is no swatch.
  const save = (next: DraftSwatch) => onChange(next.color || next.mediaId ? next : null);
  const typeColor = (next: string) => {
    setText(next);
    const color = next.trim().toLowerCase();
    if (color === "") save({ ...current, color: null });
    else if (HEX.test(color)) save({ ...current, color });
  };

  return (
    <div className="space-y-3">
      <p className="text-body text-muted-foreground">{t("swatchHint")}</p>
      <div className="space-y-1">
        <label htmlFor={`${id}-color`} className="block text-body text-muted-foreground">{t("swatchColor")}</label>
        <div className="flex items-center gap-2">
          <label
            style={{ "--swatch": current.color ?? "transparent" } as CSSProperties}
            className="relative size-11 shrink-0 cursor-pointer rounded-full border bg-(--swatch) sm:pointer-fine:size-9"
          >
            <span className="sr-only">{t("swatchPickColor", { value })}</span>
            <input
              type="color"
              value={current.color ?? "#000000"}
              onChange={(event) => typeColor(event.target.value)}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </label>
          <Input
            id={`${id}-color`}
            value={text}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            placeholder="#1f6feb"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-color-note` : undefined}
            onChange={(event) => typeColor(event.target.value)}
          />
        </div>
        {invalid ? <p id={`${id}-color-note`} className="text-body text-destructive">{t("swatchColorInvalid")}</p> : null}
      </div>
      <div className="space-y-1">
        <span className="block text-body text-muted-foreground">{t("swatchImage")}</span>
        <div className="flex flex-wrap items-center gap-2">
          {current.imageUrl ? <img src={current.imageUrl} alt="" className="size-11 rounded-full border object-cover" /> : null}
          <MediaManager
            capability="image"
            onSelect={(file) => save({ ...current, mediaId: file.id, imageUrl: file.url })}
            trigger={<Button type="button" variant="outline">{t(current.mediaId ? "swatchChangeImage" : "swatchChooseImage")}</Button>}
          />
          {current.mediaId ? (
            <Button type="button" variant="ghost" onClick={() => save({ ...current, mediaId: null, imageUrl: null })}>{t("swatchRemoveImage")}</Button>
          ) : null}
        </div>
      </div>
      {swatch ? (
        <Button type="button" variant="ghost" onClick={() => { setText(""); onChange(null); }}>{t("swatchClear")}</Button>
      ) : null}
    </div>
  );
}
