import { describe, expect, it } from "vitest";
import { FindingsMemory } from "../src/memory/findings.ts";

const T0 = Date.UTC(2026, 9, 23);

function memory() {
  let t = T0;
  return new FindingsMemory({ clock: () => (t += 1000) });
}

const weather = {
  investigationId: "inv1",
  entity: "Dominion Energy",
  claim: "Revenue rose in 2024 while Richmond winter temperatures were near normal, so weather is not the main driver.",
  verdict: "refuted" as const,
  confidence: 0.8,
  evidence: [{ queryId: "q_weather01", sql: "SELECT ...", ok: true, rowCount: 3 }],
};

describe("FindingsMemory (H-MEM)", () => {
  it("stores a finding with its query receipts in provenance and the ledger", () => {
    const m = memory();
    const rec = m.remember(weather);
    expect(rec.provenance.refs).toEqual(["q_weather01"]);
    expect(rec.source).toBe("investigation:inv1");
    const why = m.explain(rec.id);
    expect(why.ledger[0].action).toBe("create");
    expect(why.queryIds).toEqual(["q_weather01"]);
  });

  it("caps confidence when no query actually succeeded", () => {
    const m = memory();
    const rec = m.remember({ ...weather, evidence: [{ ...weather.evidence[0], ok: false }] });
    expect(rec.confidence).toBeLessThanOrEqual(0.3);
    expect(rec.provenance.refs).toEqual([]);
  });

  it("recalls findings for the same entity only", () => {
    const m = memory();
    m.remember(weather);
    m.remember({ ...weather, investigationId: "inv2", entity: "Duke Energy", claim: "Duke revenue rose with weather." });
    const hits = m.recall("why did revenue rise", "Dominion Energy");
    expect(hits.length).toBe(1);
    expect(hits[0].verdict).toBe("refuted");
    expect(hits[0].queryIds).toEqual(["q_weather01"]);
  });

  it("an analyst correction supersedes the finding and is traceable", () => {
    const m = memory();
    const rec = m.remember(weather);
    const fixed = m.correct(rec.id, "Dominion Energy: the 2024 rise came mostly from rate changes, per the 10-K.", "analyst@example.com");
    const why = m.explain(rec.id);
    expect(why.correctedBy?.id).toBe(fixed.id);
    expect(why.ledger.map((e) => e.action)).toContain("feedback");
    const hits = m.recall("why did revenue rise", "Dominion Energy");
    expect(hits.map((h) => h.memory.id)).toEqual([fixed.id]);
  });
});
