// src/components/admin/header-builder/NavigationSection.tsx
import { NavigationBuilder } from "../navigation";
import type { NavigationItem } from "./types";

interface NavigationSectionProps {
  navigation: NavigationItem[];
  onChange: (navigation: NavigationItem[]) => void;
  getStorefrontPath: (path: string) => string;
}

export function NavigationSection({
  navigation,
  onChange,
  getStorefrontPath,
}: NavigationSectionProps) {
  return (
    <NavigationBuilder
      navigation={navigation}
      onChange={onChange}
      getStorefrontPath={getStorefrontPath}
    />
  );
}
