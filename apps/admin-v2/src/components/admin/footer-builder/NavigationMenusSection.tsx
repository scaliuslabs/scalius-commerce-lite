import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Columns3,
  Plus,
  Trash2,
} from "lucide-react";
import { nanoid } from "nanoid";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NavigationBuilder } from "../navigation/NavigationBuilder";
import type { FooterMenu, NavigationItem } from "./types";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";

const MAX_FOOTER_MENUS = 4;

interface NavigationMenusSectionProps {
  editorEpoch: number;
  menus: FooterMenu[];
  onChange: (menus: FooterMenu[]) => void;
}

function moveMenu(menus: FooterMenu[], index: number, direction: -1 | 1) {
  const destination = index + direction;
  if (destination < 0 || destination >= menus.length) return menus;
  const next = [...menus];
  const [moved] = next.splice(index, 1);
  next.splice(destination, 0, moved);
  return next;
}

export function NavigationMenusSection({
  editorEpoch,
  menus,
  onChange,
}: NavigationMenusSectionProps) {
  const { getStorefrontPath } = useStorefrontUrl();
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(
    menus[0]?.id ?? null,
  );
  const selectedIndex = useMemo(
    () => menus.findIndex((menu) => menu.id === selectedMenuId),
    [menus, selectedMenuId],
  );
  const selectedMenu = selectedIndex >= 0 ? menus[selectedIndex] : null;

  useEffect(() => {
    if (selectedMenu || menus.length === 0) return;
    setSelectedMenuId(menus[0]?.id ?? null);
  }, [menus, selectedMenu]);

  const addMenu = useCallback(() => {
    if (menus.length >= MAX_FOOTER_MENUS) return;
    const newMenu: FooterMenu = {
      id: nanoid(),
      title: `Menu ${menus.length + 1}`,
      links: [],
    };
    onChange([...menus, newMenu]);
    setSelectedMenuId(newMenu.id);
  }, [menus, onChange]);

  const updateSelected = useCallback(
    (updates: Partial<FooterMenu>) => {
      if (!selectedMenu) return;
      onChange(
        menus.map((menu) =>
          menu.id === selectedMenu.id ? { ...menu, ...updates } : menu,
        ),
      );
    },
    [menus, onChange, selectedMenu],
  );

  const removeSelected = useCallback(() => {
    if (!selectedMenu) return;
    const next = menus.filter((menu) => menu.id !== selectedMenu.id);
    onChange(next);
    setSelectedMenuId(next[Math.min(selectedIndex, next.length - 1)]?.id ?? null);
  }, [menus, onChange, selectedIndex, selectedMenu]);

  const updateLinks = useCallback(
    (links: NavigationItem[]) => updateSelected({ links }),
    [updateSelected],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-medium">Footer navigation</h3>
          <p className="text-xs text-muted-foreground">
            Organize up to {MAX_FOOTER_MENUS} focused columns without opening several editors at once.
          </p>
        </div>
        <Button
          type="button"
          onClick={addMenu}
          size="sm"
          disabled={menus.length >= MAX_FOOTER_MENUS}
        >
          <Plus /> Add column
        </Button>
      </div>

      {menus.length === 0 ? (
        <div className="grid min-h-48 place-items-center rounded-lg border border-dashed px-4 py-8 text-center">
          <div>
            <Columns3 className="mx-auto h-6 w-6 text-muted-foreground/50" />
            <p className="mt-2 text-sm font-medium">No footer columns</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add a compact group for shopping, support, company, or policy links.
            </p>
            <Button type="button" size="sm" className="mt-3" onClick={addMenu}>
              <Plus /> Add first column
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid min-w-0 gap-3 xl:grid-cols-[190px_minmax(0,1fr)]">
          <nav
            className="flex gap-1 overflow-x-auto rounded-lg border bg-muted/15 p-1 xl:block xl:space-y-1 xl:overflow-visible"
            aria-label="Footer columns"
          >
            {menus.map((menu, index) => {
              const isSelected = menu.id === selectedMenuId;
              return (
                <button
                  key={menu.id}
                  type="button"
                  className={cn(
                    "flex min-w-40 shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-left xl:w-full xl:min-w-0",
                    isSelected
                      ? "bg-foreground text-background shadow-sm"
                      : "hover:bg-muted",
                  )}
                  onClick={() => setSelectedMenuId(menu.id)}
                  aria-pressed={isSelected}
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded border border-current/20 text-[11px] font-medium tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {menu.title.trim() || "Untitled column"}
                    </span>
                    <span
                      className={cn(
                        "block text-[11px]",
                        isSelected ? "text-background/65" : "text-muted-foreground",
                      )}
                    >
                      {menu.links.length} {menu.links.length === 1 ? "item" : "items"}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          {selectedMenu ? (
            <section className="min-w-0 space-y-3" aria-label="Selected footer column">
              <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
                <div className="grid min-w-48 flex-1 gap-1.5">
                  <Label htmlFor={`footer-menu-${selectedMenu.id}`}>Column heading</Label>
                  <Input
                    id={`footer-menu-${selectedMenu.id}`}
                    value={selectedMenu.title}
                    onChange={(event) => updateSelected({ title: event.target.value })}
                    className="h-9"
                    placeholder="e.g. Help"
                  />
                </div>
                <div className="flex items-center gap-1" role="group" aria-label="Arrange footer column">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    disabled={selectedIndex === 0}
                    onClick={() => onChange(moveMenu(menus, selectedIndex, -1))}
                    aria-label={`Move ${selectedMenu.title || "column"} earlier`}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    disabled={selectedIndex === menus.length - 1}
                    onClick={() => onChange(moveMenu(menus, selectedIndex, 1))}
                    aria-label={`Move ${selectedMenu.title || "column"} later`}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-destructive hover:text-destructive"
                    onClick={removeSelected}
                    aria-label={`Remove ${selectedMenu.title || "footer column"}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>

              <NavigationBuilder
                key={`${editorEpoch}:${selectedMenu.id}`}
                navigation={selectedMenu.links}
                onChange={updateLinks}
                getStorefrontPath={getStorefrontPath}
              />
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
