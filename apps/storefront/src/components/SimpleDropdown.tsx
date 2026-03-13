import React, { useState, useRef, useEffect } from "react";

interface DropdownOption {
  value: string;
  label: string;
}

interface SimpleDropdownProps {
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

export default function SimpleDropdown({
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
}: SimpleDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const toggleDropdown = () => {
    if (!disabled) {
      setIsOpen(!isOpen);
    }
  };

  const handleSelect = (option: DropdownOption) => {
    onChange(option.value);
    setIsOpen(false);
  };

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) return;

    if (e.key === "Escape") {
      setIsOpen(false);
    } else if (e.key === "Enter" && options.length > 0) {
      handleSelect(options[0]);
    }
  };

  return (
    <div ref={dropdownRef} className={`relative w-full ${className}`}>
      {/* Hidden input for form submission */}
      <input type="hidden" name={name} value={value} required={required} />

      {/* Dropdown trigger */}
      <button
        type="button"
        id={id}
        className={`flex items-center justify-between w-full px-2.5 py-1.5 text-left border rounded-md h-8 sm:h-9 text-xs sm:text-sm transition-colors focus:outline-none focus:ring-1 focus:ring-black focus:border-black ${
          triggerClassName || "bg-white"
        } ${
          disabled
            ? "opacity-50 cursor-not-allowed"
            : "cursor-pointer hover:bg-gray-50/80"
        }`}
        onClick={toggleDropdown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span
          className={`block truncate ${!selectedOption ? "text-gray-400" : ""}`}
        >
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <span className="ml-2 pointer-events-none">
          <svg
            className={`w-3.5 h-3.5 sm:w-4 sm:h-4 transition-transform ${isOpen ? "transform rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </span>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg overflow-auto max-h-[160px] sm:max-h-[180px]"
          role="listbox"
          onKeyDown={handleKeyDown}
        >
          <ul className="py-1">
            {options.length > 0 ? (
              options.map((option) => (
                <li
                  key={option.value}
                  className={`px-2.5 py-1 cursor-pointer hover:bg-gray-100 text-xs sm:text-sm ${
                    option.value === value ? "bg-gray-100 font-medium" : ""
                  }`}
                  onClick={() => handleSelect(option)}
                  role="option"
                  aria-selected={option.value === value}
                >
                  {option.label}
                </li>
              ))
            ) : (
              <li className="px-2.5 py-1.5 text-gray-500 text-center text-xs sm:text-sm">
                No options available
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
