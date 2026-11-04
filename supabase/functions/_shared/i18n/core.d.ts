// Types for the copied translator (plain JavaScript).
export function enDates(s: string): string;
export function makeTranslator(
  dict: Record<string, string>,
  // deno-lint-ignore no-explicit-any
  patterns: [RegExp, string | ((...parts: any[]) => string)][],
): (text: string) => string | undefined;
