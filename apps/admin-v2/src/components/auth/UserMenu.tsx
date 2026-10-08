import { lazy, Suspense, useState, type ReactNode } from "react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const UserMenuContent = lazy(() => import("./UserMenuContent"));

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
 * opened from the top bar's store button or the settings panel's signed-in user row.
 * The button renders at once; the menu behind it loads on first use and opens as
 * soon as it has, off the shell's first download.
 */
export function UserMenu({ user, side, children }: { user: UserMenuUser; side: "top" | "bottom"; children: ReactNode }) {
  const [asked, setAsked] = useState(false);
  // `contents` keeps the wrapper out of layout; a click (or Enter) on the button reaches it.
  if (!asked) return <span className="contents" onClickCapture={() => setAsked(true)}>{children}</span>;
  return (
    <Suspense fallback={<span className="contents">{children}</span>}>
      <UserMenuContent user={user} side={side} defaultOpen>{children}</UserMenuContent>
    </Suspense>
  );
}
