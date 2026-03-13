// src/components/auth/UserMenu.tsx
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LogOut, User, Shield, Loader2 } from "lucide-react";

interface UserMenuProps {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    role?: string | null;
    twoFactorEnabled?: boolean | null;
  };
}

export function UserMenu({ user }: UserMenuProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleSignOut = async () => {
    setIsLoading(true);
    try {
      await authClient.signOut();
      window.location.href = "/auth/login";
    } catch (error) {
      console.error("Sign out error:", error);
      setIsLoading(false);
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="relative inline-flex items-center gap-3 hover:bg-muted/50 px-2 py-1 rounded-lg transition-all duration-200"
        >
          <Avatar className="w-8 h-8 ring-2 ring-primary/10 hover:ring-primary/20 transition-all duration-200">
            {user.image && <AvatarImage src={user.image} alt={user.name} />}
            <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
              {getInitials(user.name)}
            </AvatarFallback>
          </Avatar>
          <span className="hidden md:inline-block font-medium text-sm text-foreground">
            {user.name}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-64 p-2 bg-card/95 backdrop-blur-lg border-border/50 shadow-xl"
        align="end"
        forceMount
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            <p className="text-xs leading-none text-muted-foreground">
              {user.email}
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer" asChild>
          <a
            href="/admin/settings/account"
            className="flex items-center gap-2 w-full"
          >
            <User className="h-4 w-4" />
            <span>Account Settings</span>
          </a>
        </DropdownMenuItem>
        {user.twoFactorEnabled && (
          <DropdownMenuItem className="cursor-pointer" disabled>
            <Shield className="h-4 w-4 mr-2 text-green-500" />
            <span className="text-green-600 dark:text-green-400">2FA Enabled</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer text-destructive focus:text-destructive"
          onClick={handleSignOut}
          disabled={isLoading}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <LogOut className="h-4 w-4 mr-2" />
          )}
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
