// Receipt checks. The model writes claims; this code decides whether the
// receipts hold up. A citation must point at a query that actually ran and
// returned rows, and every number in a sentence must appear in the rows it
// cites, allowing for the rounding it was written with. Anything that fails
// is flagged, not hidden.
import type { QueryRun } from "../zetaris/client.ts";

export interface NumberCheck {
  text: string;     // the number as written, e.g. "$14.4 billion" or "6.2%"
  value: number;
  percent: boolean;
  tolerance: number; // half a unit of the last written digit
  found: boolean;
}

export interface SentenceCheck {
  validCites: string[];
  droppedCites: string[];   // cited IDs that never ran or returned nothing
  numbers: NumberCheck[];
  verified: boolean;        // has a valid cite and every number is found
}

const SCALE: Record<string, number> = {
  thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, mn: 1e6, billion: 1e9, bn: 1e9, b: 1e9, trillion: 1e12,
};

export function extractNumbers(text: string): NumberCheck[] {
  const out: NumberCheck[] = [];
  // Digits glued to letters or underscores are parts of IDs (q_0fed10e232), not numbers.
  const re = /(?<![A-Za-z_\d.])(\$)?(-?\d[\d,]*(?:\.(\d+))?)\s*(%|thousand|million|billion|trillion|bn|mn|[kmb](?![a-z]))?(?![A-Za-z_\d])/gi;
  for (const m of text.matchAll(re)) {
    const [whole, dollar, digits, decimals, unitRaw] = m;
    const unit = unitRaw?.toLowerCase();
    const raw = digits.replace(/,/g, "");
    // Bare years and small counts like "3 hypotheses" are labels, not measurements.
    if (!dollar && !unit && /^(19|20)\d{2}$/.test(raw)) continue;
    if (!dollar && !unit && !decimals && Math.abs(Number(raw)) < 10) continue;
    const scale = unit && unit !== "%" ? SCALE[unit] ?? 1 : 1;
    const step = Math.pow(10, -(decimals?.length ?? 0)) * scale;
    out.push({
      text: whole.trim(),
      value: Number(raw) * scale,
      percent: unit === "%",
      tolerance: step / 2,
      found: false,
    });
  }
  return out;
}

function numericCells(runs: QueryRun[]): number[] {
  const cells: number[] = [];
  for (const r of runs) {
    for (const row of r.rows) {
      for (const v of Object.values(row)) {
        const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
        if (Number.isFinite(n)) cells.push(n);
      }
    }
  }
  return cells;
}

// A number is supported if it matches a cell, or a simple derivation of two
// cells: a difference, or a percent change.
function supported(n: NumberCheck, cells: number[]): boolean {
  const close = (x: number) => Math.abs(Math.abs(n.value) - Math.abs(x)) <= n.tolerance + 1e-9;
  if (cells.some(close)) return true;
  for (const a of cells) {
    for (const b of cells) {
      if (a === b) continue;
      if (!n.percent && close(a - b)) return true;
      if (n.percent && b !== 0 && close(((a - b) / b) * 100)) return true;
    }
  }
  return false;
}

export function checkSentence(text: string, cites: string[], runs: Map<string, QueryRun>): SentenceCheck {
  const validCites = cites.filter((id) => runs.get(id)?.ok && (runs.get(id)?.rows.length ?? 0) > 0);
  const droppedCites = cites.filter((id) => !validCites.includes(id));
  const cells = numericCells(validCites.map((id) => runs.get(id)!));
  const numbers = extractNumbers(text).map((n) => ({ ...n, found: supported(n, cells) }));
  return { validCites, droppedCites, numbers, verified: validCites.length > 0 && numbers.every((n) => n.found) };
}
