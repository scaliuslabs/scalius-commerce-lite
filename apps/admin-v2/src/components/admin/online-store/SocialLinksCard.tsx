import { GripVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SortableList } from "~/components/admin/shared/SortableList";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { ImageField } from "./ImageField";
import { SectionCard } from "./shared";

export interface SocialLink {
  id: string;
  label: string;
  url: string;
  iconUrl?: string;
}

const MAX_SOCIAL_LINKS = 8;

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
        <p className="text-sm text-muted-foreground">{t("noSocialLinks")}</p>
      ) : (
        <SortableList
          items={social}
          onReorder={onChange}
          renderItem={(link, sortable) => {
            const invalid = !isSafeSocialDestination(link.url);
            return (
              <div ref={sortable.ref} style={sortable.style} className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("reorderItem", { name: link.label || t("socialLink") })}
                    {...sortable.dragHandleProps}
                  >
                    <GripVertical />
                  </Button>
                  <Input
                    value={link.label}
                    maxLength={200}
                    placeholder={t("socialLabelPlaceholder")}
                    aria-label={t("linkLabel")}
                    onChange={(event) => update(link.id, { label: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("removeItem", { name: link.label || t("socialLink") })}
                    onClick={() => onChange(social.filter((candidate) => candidate.id !== link.id))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <div className="space-y-1.5">
                  <Input
                    type="url"
                    value={link.url}
                    placeholder="https://facebook.com/yourshop"
                    aria-label={t("linkAddress")}
                    aria-invalid={invalid}
                    onChange={(event) => update(link.id, { url: event.target.value })}
                  />
                  {invalid ? <p className="text-sm text-destructive">{t("socialLinkInvalid")}</p> : null}
                </div>
                <ImageField
                  label={t("icon")}
                  src={link.iconUrl ?? ""}
                  onChange={(image) => update(link.id, { iconUrl: image.src || undefined })}
                />
              </div>
            );
          }}
        />
      )}
    </SectionCard>
  );
}
