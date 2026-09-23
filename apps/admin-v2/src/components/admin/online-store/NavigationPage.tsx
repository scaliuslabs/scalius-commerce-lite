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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { DeferredTiptapEditor } from "~/components/ui/tiptap/DeferredTiptapEditor";
import { SaveBarProvider } from "~/components/admin/shared/SaveBar";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
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
import { SocialLinksCard, isSafeSocialDestination } from "./SocialLinksCard";
import { OnlineStorePage, SectionCard, failSave, useDocumentDraft } from "./shared";

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

  const create = async () => {
    setSaving(true);
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
    } catch (error) {
      toast.error(t("saveFailed"), { description: getServerFnError(error, t("tryAgain")) });
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
          <div className="space-y-1.5">
            <Label htmlFor="new-menu-name">{t("menuName")}</Label>
            <Input
              id="new-menu-name"
              value={name}
              maxLength={100}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
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
    <SectionCard title={t("menus")}>
      {menus.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noMenus")}</p>
      ) : (
        <ul className="-mx-4 divide-y border-t">
          {menus.items.map((menu) => {
            const locations = locationsByMenu.get(menu.id) ?? [];
            return (
              <li key={menu.id}>
                <Link
                  to="/admin/online-store/navigation/$menuId"
                  params={{ menuId: menu.id }}
                  className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{menu.name}</span>
                    <span className="block truncate text-sm text-muted-foreground">
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
    </SectionCard>
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

  return (
    <SectionCard title={t("menuLocations")} description={t("menuLocationsHelp")}>
      <div className="grid gap-4 sm:grid-cols-2">
        {SLOTS.map((slot) => {
          const key = slotKey(slot);
          return (
            <div key={key} className="space-y-1.5">
              <Label>{slotLabel(slot)}</Label>
              <Select
                value={draft[key] || "none"}
                onValueChange={(menuId) => setDraft((current) => ({
                  ...current,
                  [key]: menuId === "none" ? "" : menuId,
                }))}
              >
                <SelectTrigger aria-label={slotLabel(slot)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("noMenu")}</SelectItem>
                  {choices.map((menu) => (
                    <SelectItem key={menu.id} value={menu.id}>{menu.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
    saved: header.data.config,
    invalid: (config) => socialInvalid(config.social),
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
    saved: footer.data.config,
    invalid: (config) => socialInvalid(config.social),
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
        <div className="space-y-1.5">
          <Label htmlFor="announcement-text">{t("message")}</Label>
          <Input
            id="announcement-text"
            value={headerConfig.topBar.text}
            maxLength={200}
            placeholder={t("announcementPlaceholder")}
            onChange={(event) => setHeader({ topBar: { ...headerConfig.topBar, text: event.target.value } })}
          />
        </div>
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
          <div className="space-y-1.5">
            <Label htmlFor="contact-phone">{t("phoneNumber")}</Label>
            <Input
              id="contact-phone"
              type="tel"
              value={headerConfig.contact.phone}
              maxLength={64}
              placeholder="+880 1712 345678"
              onChange={(event) => setHeader({ contact: { ...headerConfig.contact, phone: event.target.value } })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-text">{t("phoneLabel")}</Label>
            <Input
              id="contact-text"
              value={headerConfig.contact.text}
              maxLength={200}
              placeholder={t("phoneLabelPlaceholder")}
              onChange={(event) => setHeader({ contact: { ...headerConfig.contact, text: event.target.value } })}
            />
          </div>
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
        <div className="space-y-1.5">
          <Label htmlFor="footer-tagline">{t("tagline")}</Label>
          <Input
            id="footer-tagline"
            value={footerConfig.tagline ?? ""}
            maxLength={200}
            onChange={(event) => setFooter({ tagline: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("aboutText")}</Label>
          <DeferredTiptapEditor
            content={footerConfig.description ?? ""}
            onChange={(description) => setFooter({ description })}
            ariaLabel={t("aboutText")}
            compact
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="footer-copyright">{t("copyright")}</Label>
          <Input
            id="footer-copyright"
            value={footerConfig.copyrightText ?? ""}
            maxLength={200}
            onChange={(event) => setFooter({ copyrightText: event.target.value })}
          />
          <p className="text-sm text-muted-foreground">{t("copyrightHelp")}</p>
        </div>
      </SectionCard>
    </>
  );
}

export function NavigationPage() {
  const t = useMessages(onlineStoreMessages);
  const [adding, setAdding] = useState(false);
  return (
    <SaveBarProvider>
      <OnlineStorePage
        title={t("navigationTitle")}
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="size-4" /> {t("addMenu")}
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
