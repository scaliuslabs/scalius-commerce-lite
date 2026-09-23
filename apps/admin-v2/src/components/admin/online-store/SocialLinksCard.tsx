import { GripVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SortableList } from "~/components/admin/shared/SortableList";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { ImageField } from "./ImageField";
import { Field, SectionCard } from "./shared";

export interface SocialLink {
  id: string;
  label: string;
  url: string;
  iconUrl?: string;
}

const MAX_SOCIAL_LINKS = 8;

/** Control ids of one social link, so server errors mark the right field. */
export const socialFieldId = (linkId: string, field: "label" | "url") => `social-${field}-${linkId}`;

export function isSafeSocialDestination(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** One list of social profiles, shown in the storefront header and footer. */
export function SocialLinksCard({
  social,
  onChange,
}: {
  social: SocialLink[];
  onChange: (social: SocialLink[]) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const update = (id: string, updates: Partial<SocialLink>) =>
    onChange(social.map((link) => (link.id === id ? { ...link, ...updates } : link)));

  return (
    <SectionCard
      title={t("socialLinks")}
      description={t("socialLinksHelp")}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={social.length >= MAX_SOCIAL_LINKS}
          onClick={() => onChange([...social, { id: crypto.randomUUID(), label: "", url: "" }])}
        >
          <Plus /> {t("addLink")}
        </Button>
      }
    >
      {social.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("noSocialLinks")}</p>
      ) : (
        <SortableList
          items={social}
          onReorder={onChange}
          renderItem={(link, sortable) => {
            return (
              <div
                ref={sortable.ref}
                style={sortable.style}
                className="flex items-start gap-2 rounded-lg border bg-card p-3"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-6 shrink-0 cursor-grab touch-none"
                  aria-label={t("reorderItem", { name: link.label || t("socialLink") })}
                  {...sortable.dragHandleProps}
                >
                  <GripVertical />
                </Button>
                <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                  <Field id={socialFieldId(link.id, "label")} label={t("linkLabel")}>
                    <Input
                      id={socialFieldId(link.id, "label")}
                      value={link.label}
                      maxLength={200}
                      placeholder={t("socialLabelPlaceholder")}
                      onChange={(event) => update(link.id, { label: event.target.value })}
                    />
                  </Field>
                  <Field
                    id={socialFieldId(link.id, "url")}
                    label={t("linkAddress")}
                    error={isSafeSocialDestination(link.url) ? undefined : t("socialLinkInvalid")}
                  >
                    <Input
                      id={socialFieldId(link.id, "url")}
                      type="url"
                      inputMode="url"
                      value={link.url}
                      placeholder="https://facebook.com/yourshop"
                      onChange={(event) => update(link.id, { url: event.target.value })}
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <ImageField
                      label={t("icon")}
                      src={link.iconUrl ?? ""}
                      onChange={(image) => update(link.id, { iconUrl: image.src || undefined })}
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mt-6 shrink-0"
                  aria-label={t("removeItem", { name: link.label || t("socialLink") })}
                  onClick={() => onChange(social.filter((candidate) => candidate.id !== link.id))}
                >
                  <Trash2 />
                </Button>
              </div>
            );
          }}
        />
      )}
    </SectionCard>
  );
}
