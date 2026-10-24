import { describe, expect, it } from "vitest";
import { investigate, type Llm } from "../src/agent/investigate.ts";
import { FindingsMemory } from "../src/memory/findings.ts";
import { runOffline } from "../src/zetaris/offline.ts";
import { queryId } from "../src/zetaris/client.ts";
import { NS } from "../src/agent/catalog.ts";

const REV = `SELECT report_year, revenue_usd FROM ${NS}.revenue_year ORDER BY report_year`;
const CAP = `SELECT report_year, installed_capacity_mw FROM ${NS}.utility_state_year`;
const BAD = `SELECT * FROM ${NS}.rate_cases`;

// Scripted stand-in for Nemotron: answers each step of the loop by looking
// at what the prompt asks for.
function scriptedLlm(opts: { reuse?: string } = {}): { llm: Llm; calls: string[] } {
  const calls: string[] = [];
  const llm: Llm = async <T>(messages: { content: string }[]) => {
    const p = messages[messages.length - 1].content;
    if (p.startsWith("Question:") && p.includes("Propose")) {
      calls.push("plan");
      return {
        hypotheses: [
          { id: "h1", statement: "Capacity growth drove revenue", test: "capacity rises with revenue", sql: opts.reuse ? [] : [REV, CAP], reuse_memory_id: opts.reuse ?? null },
          { id: "h2", statement: "Rate cases drove revenue", test: "rate increases", sql: [BAD] },
        ],
      } as T;
    }
    if (p.startsWith("This query failed")) {
      calls.push("repair");
      return { sql: "DROP TABLE x" } as T; // unsafe repair must be ignored
    }
    if (p.startsWith("Hypothesis:")) {
      calls.push("judge");
      return { verdict: "supported", confidence: 0.8, claim: "Revenue rose to $11.5 billion as capacity reached 21,400 MW.", cites: [queryId(REV), queryId(CAP)] } as T;
    }
    calls.push("brief");
    return {
      answer: [
        { text: "Revenue rose to $11.5 billion while capacity grew to 21,400 MW.", cites: [queryId(REV), queryId(CAP)] },
        { text: "Rate cases could not be tested, and revenue hit $99 billion.", cites: [queryId(BAD)] },
      ],
      gaps: ["No rate-case table is available."],
    } as T;
  };
  return { llm, calls };
}

describe("investigate", () => {
  it("runs, judges, verifies receipts and remembers findings", async () => {
    const memory = new FindingsMemory();
    const { llm, calls } = scriptedLlm();
    const brief = await investigate({ question: "Why did revenue rise?", entity: "SAMPLE Utility Co", llm, run: runOffline, memory });

    expect(calls).toEqual(["plan", "judge", "repair", "brief"]);
    expect(brief.hypotheses[0].verdict).toBe("supported");
    expect(brief.hypotheses[1].verdict).toBe("inconclusive");
    expect(brief.answer[0].check.verified).toBe(true);
    expect(brief.answer[1].check.verified).toBe(false);
    expect(brief.stats.queriesRun).toBe(3);
    expect(brief.stats.queriesFailed).toBe(1);
    expect(memory.recall("revenue", "SAMPLE Utility Co").length).toBeGreaterThan(0);
  });

  it("reuses a settled finding from memory instead of re-querying", async () => {
    const memory = new FindingsMemory();
    await investigate({ question: "Why did revenue rise?", entity: "SAMPLE Utility Co", llm: scriptedLlm().llm, run: runOffline, memory });
    const settled = memory.recall("capacity revenue", "SAMPLE Utility Co").find((r) => r.verdict === "supported")!;

    const { llm, calls } = scriptedLlm({ reuse: settled.memory.id });
    const brief = await investigate({ question: "Why did revenue rise?", entity: "SAMPLE Utility Co", llm, run: runOffline, memory });

    expect(brief.hypotheses[0].fromMemory).toBe(settled.memory.id);
    expect(brief.stats.hypothesesFromMemory).toBe(1);
    expect(brief.stats.queriesRun).toBe(1); // only the rate-case query ran
    expect(calls).not.toContain("judge");
  });
});
