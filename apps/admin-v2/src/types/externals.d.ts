// Type declarations for external modules without proper type exports

declare module "@daveyplate/better-auth-ui" {
  import type { FC, ReactNode } from "react";

  export interface AuthUIProviderProps {
    authClient: unknown;
    navigate?: (path: string) => void;
    replace?: (path: string) => void;
    onSessionChange?: () => void;
    twoFactor?: string[];
    credentials?: boolean;
    viewPaths?: Record<string, string>;
    basePath?: string;
    redirectTo?: string;
    children?: ReactNode;
  }

  export interface AuthFormProps {
    view?: string;
    redirectTo?: string;
    callbackURL?: string;
    classNames?: Record<string, string>;
  }

  export const AuthUIProvider: FC<AuthUIProviderProps>;
  export const AuthForm: FC<AuthFormProps>;
}

declare module "web-haptics/react" {
  export function useWebHaptics(): {
    trigger: (type: string) => void;
    isSupported: boolean;
  };
}
