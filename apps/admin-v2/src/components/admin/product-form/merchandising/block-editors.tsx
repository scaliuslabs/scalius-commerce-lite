import { useId, type ReactNode } from "react";
import { ImageIcon, Plus, Trash2, Video, X } from "lucide-react";
import type { ProductContentBlockType } from "@scalius/shared/product-content-blocks";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import { MediaManager, type MediaFile } from "@/components/admin/media-manager";
import { useMessages } from "~/i18n";
import { productMerchandisingMessages } from "~/i18n/product-merchandising";

/** A file a block names, as the editor shows it. */
export interface BlockMediaPreview {
  id: string;
  kind: "image" | "video";
  url: string;
  altText: string | null;
  posterUrl?: string | null;
}

type Settings = Record<string, unknown>;

interface EditorProps {
  type: ProductContentBlockType;
  settings: Settings;
  onChange: (settings: Settings) => void;
  media: ReadonlyMap<string, BlockMediaPreview>;
  onMediaChosen: (files: BlockMediaPreview[]) => void;
  disabled?: boolean;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

function toPreview(file: MediaFile, kind: "image" | "video"): BlockMediaPreview {
  return { id: file.id, kind, url: file.url, altText: file.altText ?? null };
}

function Field({ label, children, id }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function TextField({ label, value, onChange, max, multiline, disabled, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  multiline?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Field label={label} id={id}>
      {multiline ? (
        <Textarea id={id} value={value} maxLength={max} disabled={disabled} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input id={id} value={value} maxLength={max} disabled={disabled} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  );
}

function SelectField({ label, value, onChange, options, disabled }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} id={id}>
      <NativeSelect id={id} value={value} disabled={disabled} onValueChange={onChange}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </NativeSelect>
    </Field>
  );
}

/** One picture (or video) a block names: its preview, remove, and the library picker. */
function MediaSlot({ label, mediaId, kind, media, onChange, onMediaChosen, disabled, optional }: {
  label: string;
  mediaId: string | null;
  kind: "image" | "video";
  media: ReadonlyMap<string, BlockMediaPreview>;
  onChange: (id: string | null) => void;
  onMediaChosen: (files: BlockMediaPreview[]) => void;
  disabled?: boolean;
  optional?: boolean;
}) {
  const t = useMessages(productMerchandisingMessages);
  const file = mediaId ? media.get(mediaId) : undefined;
  const Icon = kind === "video" ? Video : ImageIcon;
  return (
    <div className="space-y-2">
      <p className="text-body font-medium">{label}</p>
      <div className="flex items-center gap-3">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
          {file && (file.kind === "image" || file.posterUrl) ? (
            <img
              src={mediaImageUrl(file.kind === "image" ? file.url : file.posterUrl!, 160)}
              alt={file.altText ?? ""}
              className="size-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <Icon className="size-6" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          {mediaId && !file ? <p className="text-body text-warning">{t("fileMissing")}</p> : null}
          {!mediaId ? <p className="text-body text-muted-foreground">{t(kind === "video" ? "noVideo" : "noImage")}</p> : null}
          {disabled ? null : (
            <div className="flex flex-wrap gap-2">
              <MediaManager
                capability={kind}
                selectedFiles={[]}
                onSelect={(chosen) => {
                  onMediaChosen([toPreview(chosen, kind)]);
                  onChange(chosen.id);
                }}
                trigger={<Button type="button" variant="outline">{t(mediaId ? "change" : kind === "video" ? "chooseVideo" : "chooseImage")}</Button>}
              />
              {mediaId && optional ? (
                <Button type="button" variant="ghost" onClick={() => onChange(null)}>{t("remove")}</Button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rows of small objects (FAQ items, features, table rows): edit, add, remove. */
function Rows<T>({ items, max, min, onChange, render, addLabel, blank, removeLabel, disabled }: {
  items: T[];
  max: number;
  min: number;
  onChange: (items: T[]) => void;
  render: (item: T, update: (next: T) => void, index: number) => ReactNode;
  addLabel: string;
  removeLabel: (index: number) => string;
  blank: () => T;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-lg border">
        {items.map((item, index) => (
          // Rows have no ids; they are edited in place and only appended or removed.
          <li key={index} className="flex items-start gap-2 p-3">
            <div className="min-w-0 flex-1 space-y-2">
              {render(item, (next) => onChange(items.map((current, at) => (at === index ? next : current))), index)}
            </div>
            {disabled || items.length <= min ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={removeLabel(index)}
                onClick={() => onChange(items.filter((_, at) => at !== index))}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {disabled || items.length >= max ? null : (
        <Button type="button" variant="outline" onClick={() => onChange([...items, blank()])}>
          <Plus className="h-4 w-4" />
          {addLabel}
        </Button>
      )}
    </div>
  );
}

/** The settings form of one content block, by type (strict schemas in @scalius/shared/product-content-blocks). */
export function BlockSettingsEditor({ type, settings, onChange, media, onMediaChosen, disabled }: EditorProps) {
  const t = useMessages(productMerchandisingMessages);
  const set = (patch: Settings) => onChange({ ...settings, ...patch });
  const heading = (
    <TextField label={t("heading")} value={str(settings.heading)} max={120} disabled={disabled} onChange={(value) => set({ heading: value })} />
  );

  switch (type) {
    case "rich-text":
      return (
        <div className="space-y-3">
          <TextField label={t("title")} value={str(settings.title)} max={200} disabled={disabled} onChange={(value) => set({ title: value })} />
          <DeferredTiptapEditor content={str(settings.html)} onChange={(html) => set({ html })} ariaLabel={t("content")} compact />
        </div>
      );
    case "image-with-text": {
      const cta = settings.cta as { label: string; href: string } | null;
      return (
        <div className="space-y-3">
          {heading}
          <TextField label={t("text")} value={str(settings.body)} max={2000} multiline disabled={disabled} onChange={(value) => set({ body: value })} />
          <MediaSlot label={t("image")} kind="image" optional mediaId={(settings.mediaId as string | null) ?? null} media={media} disabled={disabled} onMediaChosen={onMediaChosen} onChange={(mediaId) => set({ mediaId })} />
          <SelectField
            label={t("imageSide")}
            value={str(settings.imageSide) || "start"}
            disabled={disabled}
            onChange={(imageSide) => set({ imageSide })}
            options={[{ value: "start", label: t("imageStart") }, { value: "end", label: t("imageEnd") }]}
          />
          <ButtonLinkFields value={cta} disabled={disabled} onChange={(next) => set({ cta: next })} />
        </div>
      );
    }
    case "feature-list":
      return (
        <div className="space-y-3">
          {heading}
          <SelectField
            label={t("style")}
            value={str(settings.style) || "list"}
            disabled={disabled}
            onChange={(style) => set({ style })}
            options={[{ value: "list", label: t("styleList") }, { value: "cards", label: t("styleCards") }]}
          />
          <Rows<{ title: string; text: string }>
            items={list(settings.items)}
            min={1}
            max={8}
            disabled={disabled}
            addLabel={t("addFeature")}
            removeLabel={(index) => t("removeRow", { row: index + 1 })}
            blank={() => ({ title: "", text: "" })}
            onChange={(items) => set({ items })}
            render={(item, update) => (
              <>
                <TextField label={t("title")} value={item.title} max={60} disabled={disabled} onChange={(title) => update({ ...item, title })} />
                <TextField label={t("text")} value={item.text} max={240} multiline disabled={disabled} onChange={(text) => update({ ...item, text })} />
              </>
            )}
          />
        </div>
      );
    case "faq":
      return (
        <div className="space-y-3">
          {heading}
          <Rows<{ question: string; answer: string }>
            items={list(settings.items)}
            min={1}
            max={20}
            disabled={disabled}
            addLabel={t("addQuestion")}
            removeLabel={(index) => t("removeRow", { row: index + 1 })}
            blank={() => ({ question: "", answer: "" })}
            onChange={(items) => set({ items })}
            render={(item, update) => (
              <>
                <TextField label={t("question")} value={item.question} max={200} disabled={disabled} onChange={(question) => update({ ...item, question })} />
                <TextField label={t("answer")} value={item.answer} max={1000} multiline disabled={disabled} onChange={(answer) => update({ ...item, answer })} />
              </>
            )}
          />
        </div>
      );
    case "video": {
      const source = (settings.source ?? { kind: "media", mediaId: "" }) as
        | { kind: "media"; mediaId: string }
        | { kind: "embed"; url: string; posterMediaId: string | null };
      return (
        <div className="space-y-3">
          {heading}
          <SelectField
            label={t("videoSource")}
            value={source.kind}
            disabled={disabled}
            onChange={(kind) => set({ source: kind === "embed" ? { kind: "embed", url: "", posterMediaId: null } : { kind: "media", mediaId: "" } })}
            options={[{ value: "media", label: t("videoFile") }, { value: "embed", label: t("videoLink") }]}
          />
          {source.kind === "media" ? (
            <MediaSlot label={t("video")} kind="video" mediaId={source.mediaId || null} media={media} disabled={disabled} onMediaChosen={onMediaChosen} onChange={(mediaId) => set({ source: { kind: "media", mediaId: mediaId ?? "" } })} />
          ) : (
            <>
              <TextField label={t("videoUrl")} value={source.url} max={500} placeholder="https://www.youtube.com/watch?v=…" disabled={disabled} onChange={(url) => set({ source: { ...source, url } })} />
              <MediaSlot label={t("poster")} kind="image" optional mediaId={source.posterMediaId} media={media} disabled={disabled} onMediaChosen={onMediaChosen} onChange={(posterMediaId) => set({ source: { ...source, posterMediaId } })} />
            </>
          )}
        </div>
      );
    }
    case "gallery-strip": {
      const ids = list<string>(settings.mediaIds).filter(Boolean);
      return (
        <div className="space-y-3">
          {heading}
          <div className="flex flex-wrap gap-2">
            {ids.map((id) => {
              const file = media.get(id);
              return (
                <div key={id} className="relative size-20 overflow-hidden rounded-md bg-muted">
                  {file ? <img src={mediaImageUrl(file.url, 160)} alt={file.altText ?? ""} className="size-full object-cover" loading="lazy" decoding="async" /> : null}
                  {disabled ? null : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="absolute right-1 top-1 size-7"
                      aria-label={t("removeImage")}
                      onClick={() => set({ mediaIds: ids.filter((other) => other !== id) })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {disabled || ids.length >= 12 ? null : (
            <MediaManager
              capability="image"
              selectedFiles={[]}
              onSelectMultiple={(files) => {
                onMediaChosen(files.map((file) => toPreview(file, "image")));
                set({ mediaIds: [...new Set([...ids, ...files.map((file) => file.id)])].slice(0, 12) });
              }}
              trigger={<Button type="button" variant="outline">{t("addImages")}</Button>}
            />
          )}
        </div>
      );
    }
    case "statement":
      return (
        <div className="space-y-3">
          <TextField label={t("statementText")} value={str(settings.text)} max={240} multiline disabled={disabled} onChange={(text) => set({ text })} />
          <TextField label={t("accent")} value={str(settings.accent)} max={60} disabled={disabled} onChange={(accent) => set({ accent })} />
          <p className="text-body text-muted-foreground">{t("accentHelp")}</p>
        </div>
      );
    case "comparison": {
      const columns = list<{ label: string }>(settings.columns);
      const rows = list<{ label: string; values: string[] }>(settings.rows);
      const setColumns = (next: Array<{ label: string }>) => set({
        columns: next,
        rows: rows.map((row) => ({ ...row, values: next.map((_, index) => row.values[index] ?? "") })),
      });
      return (
        <div className="space-y-3">
          {heading}
          <p className="text-body font-medium">{t("columns")}</p>
          <Rows<{ label: string }>
            items={columns}
            min={2}
            max={4}
            disabled={disabled}
            addLabel={t("addColumn")}
            removeLabel={(index) => t("removeColumn", { column: index + 1 })}
            blank={() => ({ label: "" })}
            onChange={setColumns}
            render={(column, update, index) => (
              <TextField label={t("columnName", { column: index + 1 })} value={column.label} max={40} disabled={disabled} onChange={(label) => update({ label })} />
            )}
          />
          <p className="text-body font-medium">{t("rows")}</p>
          <Rows<{ label: string; values: string[] }>
            items={rows}
            min={1}
            max={20}
            disabled={disabled}
            addLabel={t("addRow")}
            removeLabel={(index) => t("removeRow", { row: index + 1 })}
            blank={() => ({ label: "", values: columns.map(() => "") })}
            onChange={(next) => set({ rows: next })}
            render={(row, update) => (
              <>
                <TextField label={t("rowName")} value={row.label} max={60} disabled={disabled} onChange={(label) => update({ ...row, label })} />
                <div className="grid gap-2 sm:grid-cols-2">
                  {columns.map((column, index) => (
                    <TextField
                      key={index}
                      label={column.label || t("columnName", { column: index + 1 })}
                      value={row.values[index] ?? ""}
                      max={80}
                      disabled={disabled}
                      onChange={(value) => update({ ...row, values: columns.map((_, at) => (at === index ? value : row.values[at] ?? "")) })}
                    />
                  ))}
                </div>
              </>
            )}
          />
        </div>
      );
    }
    case "pack-picker":
      return (
        <div className="space-y-3">
          {heading}
          <SelectField
            label={t("packSource")}
            value={str(settings.source) || "variants"}
            disabled={disabled}
            onChange={(source) => set({ source })}
            options={[{ value: "variants", label: t("packVariants") }, { value: "bundles", label: t("packBundles") }]}
          />
        </div>
      );
    case "cta-band": {
      const target = (settings.target ?? { kind: "order-form" }) as { kind: "order-form" | "buy-box" } | { kind: "link"; href: string };
      const endsAt = typeof settings.endsAt === "string" ? settings.endsAt : null;
      return (
        <div className="space-y-3">
          {heading}
          <TextField label={t("text")} value={str(settings.text)} max={300} multiline disabled={disabled} onChange={(text) => set({ text })} />
          <TextField label={t("buttonLabel")} value={str(settings.label)} max={40} disabled={disabled} onChange={(label) => set({ label })} />
          <SelectField
            label={t("buttonTarget")}
            value={target.kind}
            disabled={disabled}
            onChange={(kind) => set({ target: kind === "link" ? { kind, href: "" } : { kind } })}
            options={[
              { value: "order-form", label: t("targetOrderForm") },
              { value: "buy-box", label: t("targetBuyBox") },
              { value: "link", label: t("targetLink") },
            ]}
          />
          {target.kind === "link" ? (
            <TextField label={t("link")} value={target.href} max={300} placeholder="/collections/sale" disabled={disabled} onChange={(href) => set({ target: { kind: "link", href } })} />
          ) : null}
          <DateTimeField
            label={t("endsAt")}
            help={t("endsAtHelp")}
            value={endsAt}
            disabled={disabled}
            onChange={(value) => set({ endsAt: value })}
          />
        </div>
      );
    }
    case "order-form":
      return (
        <div className="space-y-3">
          {heading}
          <TextField label={t("submitLabel")} value={str(settings.submitLabel)} max={40} disabled={disabled} onChange={(submitLabel) => set({ submitLabel })} />
          <p className="text-body text-muted-foreground">{t("orderFormHelp")}</p>
        </div>
      );
    case "guarantee":
      return (
        <div className="space-y-3">
          {heading}
          <TextField label={t("text")} value={str(settings.text)} max={600} multiline disabled={disabled} onChange={(text) => set({ text })} />
        </div>
      );
    case "size-chart": {
      const columns = list<string>(settings.columns);
      const rows = list<string[]>(settings.rows);
      return (
        <div className="space-y-3">
          {heading}
          <p className="text-body font-medium">{t("columns")}</p>
          <Rows<string>
            items={columns}
            min={2}
            max={8}
            disabled={disabled}
            addLabel={t("addColumn")}
            removeLabel={(index) => t("removeColumn", { column: index + 1 })}
            blank={() => ""}
            onChange={(next) => set({ columns: next, rows: rows.map((row) => next.map((_, index) => row[index] ?? "")) })}
            render={(column, update, index) => (
              <TextField label={t("columnName", { column: index + 1 })} value={column} max={80} disabled={disabled} onChange={update} />
            )}
          />
          <p className="text-body font-medium">{t("rows")}</p>
          <Rows<string[]>
            items={rows}
            min={1}
            max={30}
            disabled={disabled}
            addLabel={t("addRow")}
            removeLabel={(index) => t("removeRow", { row: index + 1 })}
            blank={() => columns.map(() => "")}
            onChange={(next) => set({ rows: next })}
            render={(row, update) => (
              <div className="grid gap-2 sm:grid-cols-3">
                {columns.map((column, index) => (
                  <TextField
                    key={index}
                    label={column || t("columnName", { column: index + 1 })}
                    value={row[index] ?? ""}
                    max={40}
                    disabled={disabled}
                    onChange={(value) => update(columns.map((_, at) => (at === index ? value : row[at] ?? "")))}
                  />
                ))}
              </div>
            )}
          />
        </div>
      );
    }
    case "spec-table":
      return (
        <div className="space-y-3">
          {heading}
          <p className="text-body text-muted-foreground">{t("specTableHelp")}</p>
        </div>
      );
    default:
      return null;
  }
}

/** An optional button: label and link, or none. */
function ButtonLinkFields({ value, onChange, disabled }: {
  value: { label: string; href: string } | null;
  onChange: (value: { label: string; href: string } | null) => void;
  disabled?: boolean;
}) {
  const t = useMessages(productMerchandisingMessages);
  if (!value) {
    return disabled ? null : (
      <Button type="button" variant="outline" onClick={() => onChange({ label: "", href: "" })}>
        <Plus className="h-4 w-4" />
        {t("addButton")}
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <TextField label={t("buttonLabel")} value={value.label} max={40} disabled={disabled} onChange={(label) => onChange({ ...value, label })} />
      <TextField label={t("link")} value={value.href} max={300} placeholder="/collections/sale" disabled={disabled} onChange={(href) => onChange({ ...value, href })} />
      {disabled ? null : (
        <Button type="button" variant="ghost" onClick={() => onChange(null)}>{t("removeButton")}</Button>
      )}
    </div>
  );
}

/** A date and time in the merchant's clock, kept as an ISO instant (or none). */
function DateTimeField({ label, help, value, onChange, disabled }: {
  label: string;
  help: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const local = value ? toLocalInput(value) : "";
  return (
    <Field label={label} id={id}>
      <Input
        id={id}
        type="datetime-local"
        value={local}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          const date = next ? new Date(next) : null;
          onChange(date && !Number.isNaN(date.getTime()) ? date.toISOString() : null);
        }}
      />
      <p className="text-body text-muted-foreground">{help}</p>
    </Field>
  );
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
