import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  nextDropdownOptionIndex,
  resolveDropdownLayout,
  resolveDropdownScrollTop,
  type DropdownPlacement,
} from "@/lib/dropdown-navigation";

interface DropdownOption {
  value: string;
  label: string;
}

interface CustomDropdownProps {
  options: DropdownOption[];
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  name: string;
  id?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  triggerClassName?: string;
}

export default function CustomDropdown({
  options,
  placeholder,
  value,
  onChange,
  name,
  id,
  disabled = false,
  required = false,
  className = "",
  triggerClassName = "",
}: CustomDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState<DropdownPlacement>("below");
  const [menuMaxHeight, setMenuMaxHeight] = useState(288);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const listboxId = `${useId().replace(/:/g, "")}-listbox`;
  const selectedOption = options.find((option) => option.value === value);

  const filteredOptions = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase();
    if (!query) return options;
    return options.filter((option) =>
      option.label.toLocaleLowerCase().includes(query),
    );
  }, [options, searchTerm]);

  const updatePlacement = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const layout = resolveDropdownLayout(
      rect.top,
      rect.bottom,
      window.innerHeight,
    );
    setPlacement(layout.placement);
    setMenuMaxHeight(layout.maxHeight);
  }, []);

  const closeDropdown = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    setSearchTerm("");
    setActiveIndex(-1);
    if (restoreFocus) {
      window.requestAnimationFrame(() =>
        triggerRef.current?.focus({ preventScroll: true }),
      );
    }
  }, []);

  const openDropdown = useCallback(() => {
    if (disabled) return;
    updatePlacement();
    setSearchTerm("");
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setIsOpen(true);
  }, [disabled, options, updatePlacement, value]);

  useEffect(() => {
    function handlePointerOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        closeDropdown();
      }
    }

    document.addEventListener("mousedown", handlePointerOutside);
    return () => document.removeEventListener("mousedown", handlePointerOutside);
  }, [closeDropdown]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => {
      updatePlacement();
      searchInputRef.current?.focus({ preventScroll: true });
    });
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [isOpen, updatePlacement]);

  useEffect(() => {
    if (!isOpen) return;
    setActiveIndex((current) => {
      if (filteredOptions.length === 0) return -1;
      return current >= 0 && current < filteredOptions.length ? current : 0;
    });
  }, [filteredOptions.length, isOpen]);

  useEffect(() => {
    if (!isOpen || activeIndex < 0) return;
    const listbox = listboxRef.current;
    const option = document.getElementById(`${listboxId}-option-${activeIndex}`);
    if (!listbox || !option) return;

    const listRect = listbox.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    const nextScrollTop = resolveDropdownScrollTop(
      listbox.scrollTop,
      listRect.top,
      listRect.bottom,
      optionRect.top,
      optionRect.bottom,
    );
    if (nextScrollTop !== listbox.scrollTop) listbox.scrollTop = nextScrollTop;
  }, [activeIndex, isOpen, listboxId]);

  const handleSelect = (option: DropdownOption) => {
    onChange(option.value);
    closeDropdown(true);
  };

  const moveActive = (
    key: "ArrowDown" | "ArrowUp" | "Home" | "End",
  ) => {
    setActiveIndex((current) =>
      nextDropdownOptionIndex(current, filteredOptions.length, key),
    );
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      moveActive(event.key as "ArrowDown" | "ArrowUp" | "Home" | "End");
      return;
    }
    if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option) handleSelect(option);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeDropdown(true);
      return;
    }
    if (event.key === "Tab") closeDropdown();
  };

  return (
    <div ref={dropdownRef} className={`relative w-full ${className}`}>
      <input type="hidden" name={name} value={value} required={required} />
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`flex h-8 w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 sm:h-9 sm:text-sm ${
          triggerClassName || "border-border bg-background"
        } ${
          disabled
            ? "cursor-not-allowed opacity-50"
            : "cursor-pointer hover:bg-muted/70"
        }`}
        onClick={() => (isOpen ? closeDropdown() : openDropdown())}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            if (!isOpen) openDropdown();
          } else if (event.key === "Escape" && isOpen) {
            event.preventDefault();
            closeDropdown();
          }
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
      >
        <span className={`block truncate ${!selectedOption ? "text-muted-foreground" : ""}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <svg
          aria-hidden="true"
          className={`ml-2 h-3.5 w-3.5 shrink-0 transition-transform sm:h-4 sm:w-4 ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div
          className={`absolute z-50 flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl ${
            placement === "above" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
          style={{ maxHeight: `${menuMaxHeight}px` }}
        >
          <div className="shrink-0 border-b border-border bg-background p-2">
            <div className="relative">
              <input
                ref={searchInputRef}
                type="text"
                role="combobox"
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 pr-8 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:h-9 sm:text-sm"
                aria-label={`Search ${placeholder.toLocaleLowerCase()}`}
                aria-controls={listboxId}
                aria-expanded="true"
                aria-autocomplete="list"
                aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
                placeholder={`Search ${placeholder.toLocaleLowerCase()}`}
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                onKeyDown={handleMenuKeyDown}
              />
              {searchTerm && (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                  onClick={() => setSearchTerm("")}
                >
                  <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <ul
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            aria-label={placeholder}
            className="min-h-0 flex-1 overflow-y-auto py-1"
          >
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option, index) => (
                <li
                  key={option.value}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  className={`cursor-pointer px-2.5 py-1.5 text-xs text-foreground sm:text-sm ${
                    index === activeIndex
                      ? "bg-muted"
                      : "hover:bg-muted/70"
                  } ${option.value === value ? "font-medium" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSelect(option)}
                >
                  {option.label}
                </li>
              ))
            ) : (
              <li role="status" className="px-2.5 py-3 text-center text-xs text-muted-foreground sm:text-sm">
                No matching options
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
