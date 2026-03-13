import React, { useState, useRef, useEffect } from "react";

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
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedOption = options.find((option) => option.value === value);

  const filteredOptions = options.filter((option) =>
    option.label.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSearchTerm("");
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  const toggleDropdown = () => {
    if (!disabled) {
      setIsOpen(!isOpen);
      setSearchTerm("");
    }
  };

  const handleSelect = (option: DropdownOption) => {
    onChange(option.value);
    setIsOpen(false);
    setSearchTerm("");
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) return;

    if (e.key === "Escape") {
      setIsOpen(false);
      setSearchTerm("");
    } else if (e.key === "Enter" && filteredOptions.length > 0) {
      handleSelect(filteredOptions[0]);
    }
  };

  return (
    <div ref={dropdownRef} className={`relative w-full ${className}`}>
      <input type="hidden" name={name} value={value} required={required} />
      <button
        type="button"
        id={id}
        className={`flex items-center justify-between w-full px-2.5 py-1.5 text-left border rounded-md h-8 sm:h-9 text-xs sm:text-sm focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition-colors ${
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

      {isOpen && (
        <div
          className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
          role="listbox"
          onKeyDown={handleKeyDown}
        >
          <div className="sticky top-0 p-2 bg-white border-b border-gray-100">
            <div className="relative">
              <input
                ref={searchInputRef}
                type="text"
                className="w-full px-2.5 py-1.5 border border-gray-200 rounded-md text-xs sm:text-sm focus:outline-none focus:border-black focus:ring-1 focus:ring-black h-8 sm:h-9"
                placeholder={`Search ${placeholder.toLowerCase()}`}
                value={searchTerm}
                onChange={handleSearchChange}
                onClick={(e) => e.stopPropagation()}
              />
              {searchTerm && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5"
                  onClick={() => setSearchTerm("")}
                >
                  <svg
                    className="w-3 h-3 sm:w-3.5 sm:h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="overflow-auto max-h-[200px] sm:max-h-[240px]">
            <ul className="py-1">
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option) => (
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
                  No options found
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
