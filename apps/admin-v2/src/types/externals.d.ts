// Type declarations for external modules without proper type exports

declare module "web-haptics/react" {
  export function useWebHaptics(): {
    trigger: (type: string) => void;
    isSupported: boolean;
  };
}
