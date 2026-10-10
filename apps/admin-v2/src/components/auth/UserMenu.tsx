import { lazy, Suspense, useState, type ReactNode } from "react";

const loadUserMenuContent = () => import("./UserMenuContent");
const UserMenuContent = lazy(loadUserMenuContent);

export interface UserMenuUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
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
  // Hover or focus starts the download, so the menu is usually ready by the click.
  if (!asked) {
    return (
      <span className="contents" onPointerOverCapture={() => void loadUserMenuContent()} onFocusCapture={() => void loadUserMenuContent()} onClickCapture={() => setAsked(true)}>
        {children}
      </span>
    );
  }
  return (
    <Suspense fallback={<span className="contents">{children}</span>}>
      <UserMenuContent user={user} side={side} defaultOpen>{children}</UserMenuContent>
    </Suspense>
  );
}
