/**
 * Guardrail for the dashboard summary: every number the model writes must come from the
 * KPI JSON it was given (allowing rounding). Small counting words like "3 departments"
 * (integers ≤ 12) are tolerated.
 */

const NUMBER_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

export function extractNumbers(text: string): number[] {
  return (text.match(NUMBER_PATTERN) ?? []).map((token) => Number(token.replace(/,/g, ''))).filter(Number.isFinite);
}

export function collectNumbers(value: unknown, into: Set<number> = new Set()): Set<number> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(Math.abs(value));
  } else if (typeof value === 'string') {
    for (const n of extractNumbers(value)) into.add(n);
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectNumbers(item, into);
  }
  return into;
}

function isGrounded(n: number, allowed: Set<number>): boolean {
  if (Number.isInteger(n) && n <= 12) return true;
  for (const v of allowed) {
    if (Math.abs(n - v) < 0.005) return true;
    if (Math.abs(n - Math.round(v * 10) / 10) < 0.005) return true;
    if (Math.abs(n - Math.round(v)) < 0.005 && Math.abs(v) >= 1) return true;
  }
  return false;
}

/** Numbers in `texts` that do not appear in `source` (empty array = fully grounded). */
export function ungroundedNumbers(texts: string[], source: unknown): number[] {
  const allowed = collectNumbers(source);
  return texts.flatMap((text) => extractNumbers(text)).filter((n) => !isGrounded(n, allowed));
}
