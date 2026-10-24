// Investigation memory built on the H-MEM engine. Every finding the agent
// reaches is stored with its verdict, confidence and the IDs of the Zetaris
// queries that back it, so a later investigation can reuse verified findings
// instead of re-querying, and any recalled fact can be traced back through
// the trust ledger to the exact SQL and the analyst who corrected it.
import { HMEM } from "../engines/hmem/index.ts";
import type { LedgerEntry, MemoryRecord } from "../engines/hmem/index.ts";

export type Verdict = "supported" | "refuted" | "inconclusive";

export interface Evidence {
  queryId: string;
  sql: string;
  ok: boolean;
  rowCount: number;
}

export interface Finding {
  investigationId: string;
  entity: string;      // e.g. "Dominion Energy" or a CIK
  claim: string;       // one sentence, plain language
  verdict: Verdict;
  confidence: number;  // 0..1
  evidence: Evidence[];
}

export interface Recalled {
  memory: MemoryRecord;
  relevance: number;
  verdict?: Verdict;
  queryIds: string[];
}

export interface Explanation {
  memory: MemoryRecord;
  ledger: LedgerEntry[];
  queryIds: string[];
  correctedBy?: MemoryRecord;
}

const VERDICTS: Verdict[] = ["supported", "refuted", "inconclusive"];

export class FindingsMemory {
  readonly hmem: HMEM;

  constructor(opts: { dir?: string; clock?: () => number } = {}) {
    this.hmem = new HMEM({ persistDir: opts.dir, clock: opts.clock, actor: "receipts-agent" });
  }

  remember(f: Finding): MemoryRecord {
    // Only findings that ran at least one successful query count as evidence.
    const backed = f.evidence.filter((e) => e.ok);
    return this.hmem.add({
      content: `${f.entity}: ${f.claim}`,
      type: "factual",
      layer: f.verdict === "inconclusive" ? "short_term" : "working",
      tags: [entityTag(f.entity), `verdict:${f.verdict}`],
      confidence: backed.length ? f.confidence : Math.min(f.confidence, 0.3),
      source: `investigation:${f.investigationId}`,
      provenance: {
        origin: "plan_completion",
        learnedAt: this.hmem.clock(),
        label: `Investigation ${f.investigationId}`,
        refs: backed.map((e) => e.queryId),
      },
      missionId: f.investigationId,
    });
  }

  recall(question: string, entity?: string, topN = 8): Recalled[] {
    const result = this.hmem.query(entity ? `${entity} ${question}` : question, { topN: topN * 2, threshold: 0 });
    return result.memories
      .filter((m) => !m.memory.supersededBy && (!entity || m.memory.tags.includes(entityTag(entity))))
      .slice(0, topN)
      .map((m) => ({
        memory: m.memory,
        relevance: m.relevance,
        verdict: verdictOf(m.memory),
        queryIds: m.memory.provenance.refs ?? [],
      }));
  }

  // An analyst correction supersedes the original finding. The original is
  // kept (never silently overwritten) and both sides are on the ledger.
  correct(memoryId: string, correction: string, analyst: string): MemoryRecord {
    const original = this.hmem.store.get(memoryId);
    if (!original) throw new Error(`No memory ${memoryId}`);
    const entity = original.tags.find((t) => t.startsWith("entity:"));
    const fixed = this.hmem.add({
      content: correction,
      type: "factual",
      layer: "long_term",
      tags: [...(entity ? [entity] : []), "verdict:supported", "analyst-correction"],
      confidence: 0.95,
      source: `analyst:${analyst}`,
      provenance: {
        origin: "user_correction",
        learnedAt: this.hmem.clock(),
        label: `Corrected by ${analyst}`,
        refs: [memoryId],
      },
      supersedes: memoryId,
    });
    this.hmem.store.update(memoryId, { supersededBy: fixed.id });
    this.hmem.feedback(memoryId, "wrong");
    return fixed;
  }

  explain(memoryId: string): Explanation {
    const memory = this.hmem.store.get(memoryId);
    if (!memory) throw new Error(`No memory ${memoryId}`);
    return {
      memory,
      ledger: this.hmem.ledger.history(memoryId),
      queryIds: memory.provenance.refs ?? [],
      correctedBy: memory.supersededBy ? this.hmem.store.get(memory.supersededBy) : undefined,
    };
  }

  // Everything remembered about an entity, newest first, superseded included
  // so the UI can show what was corrected.
  list(entity?: string): Recalled[] {
    return this.hmem.store
      .all()
      .filter((m) => !entity || m.tags.includes(entityTag(entity)))
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((m) => ({ memory: m, relevance: 1, verdict: verdictOf(m), queryIds: m.provenance.refs ?? [] }));
  }

  helpful(memoryId: string): void {
    this.hmem.feedback(memoryId, "helpful");
  }
}

function entityTag(entity: string): string {
  return "entity:" + entity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function verdictOf(m: MemoryRecord): Verdict | undefined {
  return VERDICTS.find((v) => m.tags.includes(`verdict:${v}`));
}
