/** Whether what was typed confirms the phrase: case and outer spaces do not matter, the name itself does. */
export function typedConfirmMatches(phrase: string, typed: string): boolean {
  return phrase.trim() !== "" && typed.trim().toLocaleLowerCase() === phrase.trim().toLocaleLowerCase();
}
