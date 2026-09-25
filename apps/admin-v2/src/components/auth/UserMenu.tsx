import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Languages, LogOut, SunMoon, UserRound } from "lucide-react";
import { toast } from "sonner";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type ThemePreference } from "@/components/admin/layout/ThemeProvider";
import { broadcastAdminSignOut } from "@/components/auth/AdminSessionSync";
import { clearAdminRouteContextCache } from "@/lib/admin-route-context";
import { withDashboardBasePath } from "@/lib/dashboard-base-path";
import { LOCALES, setLocale, useLocale, useMessages, type Locale } from "~/i18n";
import { shellMessages } from "~/i18n/shell";

export interface UserMenuUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0, 2);
}

/** The signed-in user's picture, or their initials. */
export function UserAvatar({ user }: { user: UserMenuUser }) {
  return (
    <Avatar className="size-7">
      {user.image ? <AvatarImage src={mediaImageUrl(user.image, 160)} alt="" className="object-cover" /> : null}
      <AvatarFallback><span className="text-caption font-semibold text-foreground">{initials(user.name)}</span></AvatarFallback>
    </Avatar>
  );
}

/**
 * The account menu (My account, dashboard language, light/dark, sign out),
 * opened from the navigation's store row, rail badge or signed-in user row.
 */
export function UserMenu({ user, side, children }: { user: UserMenuUser; side: "top" | "right"; children: ReactNode }) {
  const t = useMessages(shellMessages);
  const locale = useLocale();
  const { preference, setPreference } = useTheme();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      clearAdminRouteContextCache();
      const { authClient } = await import("@/lib/auth-client");
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message);
      broadcastAdminSignOut();
      window.location.replace(withDashboardBasePath("/auth/login"));
    } catch {
      toast.error(t("signOutFailed"));
      setSigningOut(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={side === "top" ? "start" : "end"} sideOffset={8} className="w-64">
        <div className="px-2 py-1.5">
          <p className="truncate text-body font-medium">{user.name}</p>
          <p className="truncate text-body text-muted-foreground">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/admin/account">
            <UserRound className="mr-2 h-4 w-4" />
            {t("myAccount")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="flex items-center gap-2 px-2 pb-1 pt-1.5 text-body text-muted-foreground">
          <Languages className="size-4" aria-hidden />
          {t("language")}
        </div>
        <DropdownMenuRadioGroup value={locale} onValueChange={(value) => setLocale(value as Locale)}>
          {LOCALES.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} lang={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <div className="flex items-center gap-2 px-2 pb-1 pt-1.5 text-body text-muted-foreground">
          <SunMoon className="size-4" aria-hidden />
          {t("theme")}
        </div>
        <DropdownMenuRadioGroup value={preference} onValueChange={(value) => setPreference(value as ThemePreference)}>
          <DropdownMenuRadioItem value="light">{t("themeLight")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t("themeDark")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">{t("themeSystem")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();
            void signOut();
          }}
        >
          <LogOut className="mr-2 h-4 w-4" />
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
