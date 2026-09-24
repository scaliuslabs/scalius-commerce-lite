import { useMemo, useState } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  postApiV1AdminNavigationMenus,
  postApiV1AdminNavigationMenusByMenuIdPublish,
  postApiV1AdminSettingsFooter,
  postApiV1AdminSettingsHeader,
  putApiV1AdminNavigationPlacementsByPlacementId,
} from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { DeferredTiptapEditor } from "~/components/ui/tiptap/DeferredTiptapEditor";
import { SaveBarProvider } from "~/components/admin/shared/SaveBar";
import { apiData } from "~/lib/api";
import type {
  NavigationMenuSummary,
  NavigationPlacementSetting,
} from "~/lib/api-query-options/navigation";
import {
  footerQueryOptions,
  headerQueryOptions,
  navigationMenusQueryOptions,
  navigationPlacementsQueryOptions,
} from "~/lib/api-query-options/online-store";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { SocialLinksCard, isSafeSocialDestination, socialFieldId, type SocialLink } from "./SocialLinksCard";
import { actionErrorText, failSave, Field, OnlineStorePage, SectionCard, useDocumentDraft } from "./shared";

/** `social.2.url` → the control that shows it. */
function socialField(path: string, social: SocialLink[]): string | undefined {
  const [group, index, field] = path.split(".");
  const link = group === "social" ? social[Number(index)] : undefined;
  return link && (field === "url" || field === "label") ? socialFieldId(link.id, field) : undefined;
}

/** Storefront slots a menu can fill: the header menu and four footer columns. */
const SLOTS = [
  { surface: "header", slot: "primary", position: 0 },
  { surface: "footer", slot: "column", position: 0 },
  { surface: "footer", slot: "column", position: 1 },
  { surface: "footer", slot: "column", position: 2 },
  { surface: "footer", slot: "column", position: 3 },
] as const;
type Slot = (typeof SLOTS)[number];
const slotKey = (slot: Slot) => `${slot.surface}:${slot.slot}:${slot.position}`;

function findPlacement(placements: NavigationPlacementSetting[], slot: Slot) {
  return placements.find(({ placement }) => (
    placement.surface === slot.surface &&
    placement.slot === slot.slot &&
    placement.position === slot.position
  ));
}

function useSlotLabel() {
  const t = useMessages(onlineStoreMessages);
  return (slot: Slot) => slot.surface === "header"
    ? t("headerMenu")
    : t("footerColumn", { number: slot.position + 1 });
}

function AddMenuDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(onlineStoreMessages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const create = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const { menu } = await apiData(postApiV1AdminNavigationMenus({ body: { name: name.trim() } }));
      const created = menu as unknown as NavigationMenuSummary;
      // Publish the empty menu so later edits always have a version to return to.
      await apiData(postApiV1AdminNavigationMenusByMenuIdPublish({
        path: { menuId: created.id },
        body: { expectedRevision: created.revision },
      }));
      await queryClient.invalidateQueries({ queryKey: navigationMenusQueryOptions().queryKey });
      toast.success(t("menuCreated"));
      onOpenChange(false);
      setName("");
      void navigate({ to: "/admin/online-store/navigation/$menuId", params: { menuId: created.id } });
    } catch (failure) {
      setError(actionErrorText(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addMenu")}</DialogTitle>
          <DialogDescription>{t("addMenuHelp")}</DialogDescription>
        </DialogHeader>
        <form
          method="post"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !saving) void create();
          }}
        >
          <Field id="new-menu-name" label={t("menuName")}>
            <Input
              id="new-menu-name"
              value={name}
              maxLength={100}
              autoFocus
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "new-menu-name-error" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(undefined);
              }}
            />
          </Field>
          {error ? <p id="new-menu-name-error" role="alert" className="text-body text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" loading={saving} disabled={!name.trim()}>
              {t("addMenu")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MenusCard() {
  const t = useMessages(onlineStoreMessages);
  const slotLabel = useSlotLabel();
  const { data: menus } = useSuspenseQuery(navigationMenusQueryOptions());
  const { data: placements } = useSuspenseQuery(navigationPlacementsQueryOptions());
  const locationsByMenu = new Map<string, string[]>();
  for (const slot of SLOTS) {
    const placement = findPlacement(placements, slot)?.placement;
    if (!placement?.isEnabled) continue;
    locationsByMenu.set(placement.menuId, [...(locationsByMenu.get(placement.menuId) ?? []), slotLabel(slot)]);
  }

  return (
    <SectionCard
      title={t("menus")}
      description={menus.items.length === 0 ? t("noMenus") : undefined}
      rows={menus.items.length === 0 ? undefined : (
        <ul>
          {menus.items.map((menu) => {
            const locations = locationsByMenu.get(menu.id) ?? [];
            return (
              <li key={menu.id}>
                <Link
                  to="/admin/online-store/navigation/$menuId"
                  params={{ menuId: menu.id }}
                  className="flex min-h-14 items-center gap-3 border-t border-border px-4 py-3 hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-medium">{menu.name}</span>
                    <span className="block text-body text-muted-foreground">
                      {[
                        menu.itemCount === 1 ? t("oneItem") : t("itemCount", { count: menu.itemCount }),
                        locations.length ? locations.join(", ") : t("notShown"),
                        menu.revision !== menu.publishedRevision ? t("unpublishedChanges") : null,
                      ].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    />
  );
}

function LocationsCard() {
  const t = useMessages(onlineStoreMessages);
  const slotLabel = useSlotLabel();
  const queryClient = useQueryClient();
  const { data: menus } = useSuspenseQuery(navigationMenusQueryOptions());
  const placementsQuery = useSuspenseQuery(navigationPlacementsQueryOptions());
  const placements = placementsQuery.data;
  const saved = useMemo(
    () => Object.fromEntries(SLOTS.map((slot) => {
      const placement = findPlacement(placements, slot)?.placement;
      return [slotKey(slot), placement?.isEnabled ? placement.menuId : ""];
    })) as Record<string, string>,
    [placements],
  );
  const { draft, setDraft } = useDocumentDraft({
    label: t("menuLocations"),
    saved,
    save: async (next) => {
      try {
        for (const slot of SLOTS) {
          const key = slotKey(slot);
          if (next[key] === saved[key]) continue;
          const current = findPlacement(placements, slot)?.placement;
          await apiData(putApiV1AdminNavigationPlacementsByPlacementId({
            path: { placementId: current?.id ?? `placement_${slot.surface}_${slot.slot}_${slot.position}` },
            body: {
              expectedRevision: current?.revision ?? 0,
              surface: slot.surface,
              slot: slot.slot,
              position: slot.position,
              menuId: next[key] || current!.menuId,
              labelOverride: current?.labelOverride ?? null,
              isEnabled: Boolean(next[key]),
            },
          }));
        }
      } catch (error) {
        failSave(error, () => void placementsQuery.refetch());
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: navigationPlacementsQueryOptions().queryKey }),
          queryClient.invalidateQueries({ queryKey: navigationMenusQueryOptions().queryKey }),
        ]);
      }
    },
  });
  const choices = menus.items.filter((menu) => menu.publishedRevision != null);
  const menuOptions = [
    { value: "none", label: t("noMenu") },
    ...choices.map((menu) => ({ value: menu.id, label: menu.name })),
  ];

  return (
    <SectionCard title={t("menuLocations")} description={t("menuLocationsHelp")}>
      <div className="grid gap-4 sm:grid-cols-2">
        {SLOTS.map((slot) => {
          const key = slotKey(slot);
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`menu-location-${key}`}>{slotLabel(slot)}</Label>
              <SearchableSelect
                id={`menu-location-${key}`}
                value={draft[key] || "none"}
                onValueChange={(menuId) => setDraft((current) => ({
                  ...current,
                  [key]: menuId === "none" ? "" : menuId,
                }))}
                options={menuOptions}
                triggerClassName="w-full"
              />
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

function StoreDetailsCards() {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const header = useSuspenseQuery(headerQueryOptions());
  const footer = useSuspenseQuery(footerQueryOptions());
  const socialInvalid = (social: { url: string }[]) =>
    social.some((link) => !isSafeSocialDestination(link.url));
  const headerDraft = useDocumentDraft({
    label: t("header"),
    saved: header.data.config,
    invalid: (config) => socialInvalid(config.social),
    fields: (path, config) =>
      socialField(path, config.social) ?? ({
        "topBar.text": "announcement-text",
        "contact.phone": "contact-phone",
        "contact.text": "contact-text",
      } as Record<string, string>)[path],
    save: async (config) => {
      try {
        const saved = await apiData(postApiV1AdminSettingsHeader({
          body: { ...config, expectedRevision: header.data.revision },
        }));
        queryClient.setQueryData(headerQueryOptions().queryKey, { config, revision: saved.revision });
      } catch (error) {
        failSave(error, () => void header.refetch());
      }
    },
  });
  const footerDraft = useDocumentDraft({
    label: t("footer"),
    saved: footer.data.config,
    invalid: (config) => socialInvalid(config.social),
    fields: (path, config) =>
      socialField(path, config.social) ??
      ({ tagline: "footer-tagline", copyrightText: "footer-copyright" } as Record<string, string>)[path],
    save: async (config) => {
      try {
        const saved = await apiData(postApiV1AdminSettingsFooter({
          body: { ...config, expectedRevision: footer.data.revision },
        }));
        queryClient.setQueryData(footerQueryOptions().queryKey, { config, revision: saved.revision });
      } catch (error) {
        failSave(error, () => void footer.refetch());
      }
    },
  });
  const headerConfig = headerDraft.draft;
  const footerConfig = footerDraft.draft;
  const setHeader = (updates: Partial<typeof headerConfig>) =>
    headerDraft.setDraft((current) => ({ ...current, ...updates }));
  const setFooter = (updates: Partial<typeof footerConfig>) =>
    footerDraft.setDraft((current) => ({ ...current, ...updates }));

  return (
    <>
      <SectionCard
        title={t("announcementBar")}
        description={t("announcementBarHelp")}
        action={
          <Switch
            checked={headerConfig.topBar.isEnabled}
            aria-label={t("announcementBar")}
            onCheckedChange={(isEnabled) => setHeader({ topBar: { ...headerConfig.topBar, isEnabled } })}
          />
        }
      >
        <Field id="announcement-text" label={t("message")}>
          <Input
            id="announcement-text"
            value={headerConfig.topBar.text}
            maxLength={200}
            placeholder={t("announcementPlaceholder")}
            onChange={(event) => setHeader({ topBar: { ...headerConfig.topBar, text: event.target.value } })}
          />
        </Field>
      </SectionCard>

      <SectionCard
        title={t("headerPhone")}
        description={t("headerPhoneHelp")}
        action={
          <Switch
            checked={headerConfig.contact.isEnabled}
            aria-label={t("headerPhone")}
            onCheckedChange={(isEnabled) => setHeader({ contact: { ...headerConfig.contact, isEnabled } })}
          />
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="contact-phone" label={t("phoneNumber")}>
            <Input
              id="contact-phone"
              type="tel"
              value={headerConfig.contact.phone}
              maxLength={64}
              placeholder="+880 1712 345678"
              onChange={(event) => setHeader({ contact: { ...headerConfig.contact, phone: event.target.value } })}
            />
          </Field>
          <Field id="contact-text" label={t("phoneLabel")}>
            <Input
              id="contact-text"
              value={headerConfig.contact.text}
              maxLength={200}
              placeholder={t("phoneLabelPlaceholder")}
              onChange={(event) => setHeader({ contact: { ...headerConfig.contact, text: event.target.value } })}
            />
          </Field>
        </div>
      </SectionCard>

      <SocialLinksCard
        social={footerConfig.social}
        onChange={(social) => {
          setHeader({ social });
          setFooter({ social });
        }}
      />

      <SectionCard title={t("footer")}>
        <Field id="footer-tagline" label={t("tagline")}>
          <Input
            id="footer-tagline"
            value={footerConfig.tagline ?? ""}
            maxLength={200}
            onChange={(event) => setFooter({ tagline: event.target.value })}
          />
        </Field>
        <div className="space-y-1.5">
          <Label id="footer-about-label">{t("aboutText")}</Label>
          <DeferredTiptapEditor
            content={footerConfig.description ?? ""}
            onChange={(description) => setFooter({ description })}
            ariaLabel={t("aboutText")}
            compact
          />
        </div>
        <Field id="footer-copyright" label={t("copyright")} help={t("copyrightHelp")}>
          <Input
            id="footer-copyright"
            value={footerConfig.copyrightText ?? ""}
            maxLength={200}
            aria-describedby="footer-copyright-note"
            onChange={(event) => setFooter({ copyrightText: event.target.value })}
          />
        </Field>
      </SectionCard>
    </>
  );
}

export function NavigationPage() {
  const t = useMessages(onlineStoreMessages);
  const [adding, setAdding] = useState(false);
  return (
    <SaveBarProvider savedMessage={t("navigationSaved")}>
      <OnlineStorePage
        title={t("navigationTitle")}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> {t("addMenu")}
          </Button>
        }
      >
        <MenusCard />
        <LocationsCard />
        <StoreDetailsCards />
      </OnlineStorePage>
      <AddMenuDialog open={adding} onOpenChange={setAdding} />
    </SaveBarProvider>
  );
}
