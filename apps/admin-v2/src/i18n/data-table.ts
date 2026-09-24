import { defineMessages } from "./index";

/** The shared list table: column menu, sorting, identifiers. */
export const dataTableMessages = defineMessages({
  en: {
    columnMenu: "Sort and columns",
    sortBy: "Sort by",
    sortField: "Sort field",
    ascending: "Ascending",
    descending: "Descending",
    columns: "Columns",
    showColumn: "Show {name}",
    hideColumn: "Hide {name}",
    alwaysShown: "Always shown",
    moveColumn: "Move {name}. Use the up and down arrow keys.",
    hiddenToFit: "{count} columns hidden to fit this width",
    hiddenToFitOne: "1 column hidden to fit this width",
    resetColumns: "Reset to default",
    copy: "Copy {value}",
    copied: "Copied",
  },
  bn: {
    columnMenu: "সাজানো ও কলাম",
    sortBy: "সাজান",
    sortField: "যেভাবে সাজাবেন",
    ascending: "ছোট থেকে বড়",
    descending: "বড় থেকে ছোট",
    columns: "কলাম",
    showColumn: "{name} দেখান",
    hideColumn: "{name} লুকান",
    alwaysShown: "সবসময় দেখানো হয়",
    moveColumn: "{name} সরান। উপর ও নিচের অ্যারো কী ব্যবহার করুন।",
    hiddenToFit: "জায়গা কম বলে {count}টি কলাম লুকানো আছে",
    hiddenToFitOne: "জায়গা কম বলে ১টি কলাম লুকানো আছে",
    resetColumns: "আগের মতো করুন",
    copy: "{value} কপি করুন",
    copied: "কপি হয়েছে",
  },
});
