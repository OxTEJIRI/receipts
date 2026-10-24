import { describe, expect, it } from "vitest";
import { checkSentence, extractNumbers } from "../src/agent/verify.ts";
import type { QueryRun } from "../src/zetaris/client.ts";

const run = (id: string, rows: Record<string, unknown>[], ok = true): QueryRun =>
  ({ id, sql: "SELECT 1", ok, rows, columns: [], ms: 1, at: "" });

const runs = new Map<string, QueryRun>([
  ["q_rev", run("q_rev", [{ report_year: 2023, revenue_usd: 14_393_000_000 }, { report_year: 2024, revenue_usd: 14_459_000_000 }])],
  ["q_fail", run("q_fail", [], false)],
]);

describe("extractNumbers", () => {
  it("reads scaled money and percents, skips bare years and small counts", () => {
    const n = extractNumbers("In 2024 revenue was $14.46 billion, up 0.5% across 3 states.");
    expect(n.map((x) => x.text)).toEqual(["$14.46 billion", "0.5%"]);
    expect(n[0].value).toBeCloseTo(14.46e9);
    expect(n[0].tolerance).toBeCloseTo(0.005e9);
  });

  it("ignores digits inside query and memory IDs", () => {
    expect(extractNumbers("see q_0fed10e232 and mem_12 for revenue_usd")).toEqual([]);
  });
});

describe("checkSentence", () => {
  it("verifies a number that matches a cell at its written precision", () => {
    const c = checkSentence("Revenue reached $14.46 billion in 2024.", ["q_rev"], runs);
    expect(c.verified).toBe(true);
  });

  it("verifies a derived percent change", () => {
    const c = checkSentence("Revenue grew 0.46% year over year.", ["q_rev"], runs);
    expect(c.verified).toBe(true);
  });

  it("flags a number that is not in the cited rows", () => {
    const c = checkSentence("Revenue reached $15.2 billion.", ["q_rev"], runs);
    expect(c.verified).toBe(false);
    expect(c.numbers[0].found).toBe(false);
  });

  it("drops citations to failed or unknown queries", () => {
    const c = checkSentence("Weather explains it.", ["q_fail", "q_made_up"], runs);
    expect(c.validCites).toEqual([]);
    expect(c.droppedCites).toEqual(["q_fail", "q_made_up"]);
    expect(c.verified).toBe(false);
  });
});
