import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Languages, LogOut, UserRound } from "lucide-react";
import { toast } from "sonner";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DarkModeToggle } from "@/components/ui/DarkModeToggle";
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

/** Avatar menu: My account, dashboard language, sign out. */
export function UserMenu({ user }: { user: UserMenuUser }) {
  const t = useMessages(shellMessages);
  const locale = useLocale();
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
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex h-11 items-center gap-2 rounded-md px-1.5 text-white hover:bg-white/10 sm:h-9">
          <Avatar className="h-7 w-7">
            {user.image ? <AvatarImage src={mediaImageUrl(user.image, 160)} alt="" className="object-cover" /> : null}
            <AvatarFallback><span className="text-xs font-semibold text-foreground">{initials(user.name)}</span></AvatarFallback>
          </Avatar>
          <span className="hidden max-w-40 truncate text-sm font-medium md:inline">{user.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/admin/account">
            <UserRound className="mr-2 h-4 w-4" />
            {t("myAccount")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center text-sm font-normal text-muted-foreground">
          <Languages className="mr-2 h-4 w-4" />
          {t("language")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={locale} onValueChange={(value) => setLocale(value as Locale)}>
          {LOCALES.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} lang={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <div className="flex items-center justify-between px-2 text-sm">
          <span>{t("darkMode")}</span>
          <DarkModeToggle />
        </div>
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
