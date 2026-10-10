import { ChevronLeft, X } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { UserMenu, type UserMenuUser } from "~/components/auth/UserMenu";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { SettingsNav } from "../settings/SettingsNav";
import { NAV_ICON_BUTTON, NAV_ROW } from "./nav-button";

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0, 2);
}

/** The signed-in user's picture, or their initials. */
function UserAvatar({ user }: { user: UserMenuUser }) {
  return (
    <Avatar className="size-7">
      {user.image ? <AvatarImage src={mediaImageUrl(user.image, 160)} alt="" className="object-cover" /> : null}
      <AvatarFallback><span className="text-caption font-semibold text-foreground">{initials(user.name)}</span></AvatarFallback>
    </Avatar>
  );
}

/**
 * The settings takeover: Back and the title, then the settings list with its
 * search and the store block, and the signed-in user at the bottom.
 */
export function SettingsPanel({ user, onBack, onClose }: { user: UserMenuUser; onBack: () => void; onClose?: () => void }) {
  const t = useMessages(shellMessages);
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-1 px-2">
        <button type="button" onClick={onBack} aria-label={t("back")} className={NAV_ICON_BUTTON}>
          <ChevronLeft className="rtl:rotate-180" aria-hidden />
        </button>
        <h2 className="flex-1 truncate text-nav font-semibold text-sidebar-foreground">{t("settings")}</h2>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label={t("closeMenu")} className={NAV_ICON_BUTTON}>
            <X aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        <SettingsNav variant="sidebar" onNavigate={onClose} />
      </div>
      <div className="shrink-0 border-t border-sidebar-border p-2">
        <UserMenu user={user} side="top">
          <button type="button" className={cn(NAV_ROW, "h-auto min-h-11 gap-2 py-1 md:h-auto")}>
            <UserAvatar user={user} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-sidebar-foreground">{user.name}</span>
              <span className="block truncate text-caption text-sidebar-muted-foreground">{user.email}</span>
            </span>
          </button>
        </UserMenu>
      </div>
    </>
  );
}
