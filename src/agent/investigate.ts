// The investigation loop. Given a "why" question about an entity:
//   1. recall settled findings from H-MEM,
//   2. plan competing hypotheses, each with SQL that could test it,
//   3. run the SQL through Zetaris (one repair attempt on a failed query),
//   4. judge each hypothesis only from rows that came back,
//   5. store the verdicts in H-MEM with their query IDs,
//   6. write a brief where every sentence cites queries or memories,
// and then check every receipt in code before showing it.
import { randomUUID } from "node:crypto";
import type { QueryRun } from "../zetaris/client.ts";
import type { ChatMessage } from "../llm/nemotron.ts";
import type { FindingsMemory, Recalled, Verdict } from "../memory/findings.ts";
import { catalogPrompt, cikFor } from "./catalog.ts";
import { queryId } from "../zetaris/client.ts";
import { checkSentence, type SentenceCheck } from "./verify.ts";

export type Llm = <T>(messages: ChatMessage[]) => Promise<T>;
export type Runner = (sql: string) => Promise<QueryRun>;

export interface Hypothesis {
  id: string;
  statement: string;
  test: string;          // what result would support or refute it
  sql: string[];
  queryIds: string[];
  verdict: Verdict;
  confidence: number;
  claim: string;
  fromMemory?: string;   // memory ID when settled by an earlier investigation
}

export interface BriefSentence {
  text: string;
  cites: string[];       // query IDs (q_...) or memory IDs
  check: SentenceCheck;
}

export interface Brief {
  id: string;
  question: string;
  entity: string;
  answer: BriefSentence[];
  hypotheses: Hypothesis[];
  gaps: string[];
  queries: QueryRun[];
  recalled: Recalled[];
  stats: {
    queriesRun: number;
    queriesFailed: number;
    hypothesesFromMemory: number;
    sentencesVerified: number;
    sentencesTotal: number;
    ms: number;
  };
}

export type InvestigationEvent =
  | { type: "recalled"; items: Recalled[] }
  | { type: "planned"; hypotheses: Pick<Hypothesis, "id" | "statement" | "fromMemory">[] }
  | { type: "query"; hypothesisId: string; run: QueryRun }
  | { type: "verdict"; hypothesis: Hypothesis }
  | { type: "brief"; brief: Brief };

export interface InvestigateOptions {
  question: string;
  entity: string;
  llm: Llm;
  run: Runner;
  memory: FindingsMemory;
  onEvent?: (e: InvestigationEvent) => void;
  maxHypotheses?: number;
}

const SYSTEM = `You are Receipts, an investigator that explains why a business metric moved.
You may only use the tables listed. Write Spark-compatible Lightning SQL, one SELECT per string, no DDL or writes.
Use fully qualified table names exactly as listed. Keep result sets small (aggregate, LIMIT 50).
Never state a cause you have not tested. Reply with JSON only.`;

interface PlanReply {
  hypotheses: { id: string; statement: string; test: string; sql: string[]; reuse_memory_id?: string }[];
}
interface RepairReply { sql: string }
interface JudgeReply { verdict: Verdict; confidence: number; claim: string; cites: string[] }
interface BriefReply { answer: { text: string; cites: string[] }[]; gaps: string[] }

const ROWS_FOR_LLM = 25;

function rowsForLlm(run: QueryRun): string {
  if (!run.ok) return `${run.id}: FAILED (${run.error?.slice(0, 200)})`;
  const rows = run.rows.slice(0, ROWS_FOR_LLM);
  const more = run.rows.length > ROWS_FOR_LLM ? ` (+${run.rows.length - ROWS_FOR_LLM} more rows)` : "";
  return `${run.id}: ${run.sql}\nrows${more}: ${JSON.stringify(rows)}`;
}

export async function investigate(opts: InvestigateOptions): Promise<Brief> {
  const started = Date.now();
  const { question, entity, llm, run, memory, onEvent } = opts;
  const id = "inv_" + randomUUID().slice(0, 8);
  const runs = new Map<string, QueryRun>();

  // 1. Recall
  const recalled = memory.recall(question, entity).filter((r) => r.verdict && r.verdict !== "inconclusive");
  onEvent?.({ type: "recalled", items: recalled });
  const memoryIds = new Set(recalled.map((r) => r.memory.id));

  // 2. Plan
  const plan = await llm<PlanReply>([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Question: ${question}\nEntity: ${entity}${cikFor(entity) ? ` (cik '${cikFor(entity)}')` : ""}\n\nTables:\n${catalogPrompt()}\n\n` +
        `Settled findings from earlier investigations (reuse instead of re-querying when one already settles a hypothesis):\n` +
        (recalled.length
          ? recalled.map((r) => `${r.memory.id} [${r.verdict}, confidence ${r.memory.confidence.toFixed(2)}] ${r.memory.content}`).join("\n")
          : "(none)") +
        `\n\nPropose ${opts.maxHypotheses ?? 4} competing hypotheses that could explain the answer, including at least one that the data might refute. ` +
        `For each give: id (h1, h2...), statement (one sentence), test (one sentence: what result supports or refutes it), sql (1-2 compact queries; filter by cik directly when the entity's CIK is known, otherwise join company on company_name), ` +
        `and reuse_memory_id if a settled finding already answers it (then sql may be empty).\n` +
        `JSON: {"hypotheses":[{"id":"h1","statement":"...","test":"...","sql":["SELECT ..."],"reuse_memory_id":null}]}`,
    },
  ]);

  const hypotheses: Hypothesis[] = plan.hypotheses.slice(0, opts.maxHypotheses ?? 4).map((h) => {
    const reused = h.reuse_memory_id && memoryIds.has(h.reuse_memory_id)
      ? recalled.find((r) => r.memory.id === h.reuse_memory_id)
      : undefined;
    return {
      id: h.id,
      statement: h.statement,
      test: h.test,
      sql: reused ? [] : (h.sql ?? []).filter((s) => /^\s*(select|with)\b/i.test(s)),
      queryIds: reused ? reused.queryIds : [],
      verdict: reused?.verdict ?? "inconclusive",
      confidence: reused?.memory.confidence ?? 0,
      claim: reused?.memory.content ?? "",
      fromMemory: reused?.memory.id,
    };
  });
  onEvent?.({ type: "planned", hypotheses: hypotheses.map(({ id, statement, fromMemory }) => ({ id, statement, fromMemory })) });

  // 3. Run every open hypothesis's SQL. Sequential, so a query planned under
  // two hypotheses hits the cache and runs once.
  for (const h of hypotheses.filter((h) => h.fromMemory)) {
    memory.helpful(h.fromMemory!);
    onEvent?.({ type: "verdict", hypothesis: h });
  }
  const open = hypotheses.filter((h) => !h.fromMemory);
  const hRunsById = new Map<string, QueryRun[]>();
  for (const h of open) {
    const hRuns: QueryRun[] = [];
    hRunsById.set(h.id, hRuns);
    for (const sql of h.sql) {
      // The same SQL planned under two hypotheses runs once.
      const cached = runs.get(queryId(sql.trim().replace(/;+\s*$/, "")));
      if (cached?.ok) {
        hRuns.push(cached);
        onEvent?.({ type: "query", hypothesisId: h.id, run: cached });
        continue;
      }
      let r = await run(sql);
      if (!r.ok) {
        const fix = await llm<RepairReply>([
          { role: "system", content: SYSTEM },
          { role: "user", content: `This query failed.\nSQL: ${sql}\nError: ${r.error}\n\nTables:\n${catalogPrompt()}\n\nReturn a corrected single SELECT. JSON: {"sql":"SELECT ..."}` },
        ]).catch(() => undefined);
        if (fix?.sql && /^\s*(select|with)\b/i.test(fix.sql)) r = await run(fix.sql);
      }
      runs.set(r.id, r);
      hRuns.push(r);
      onEvent?.({ type: "query", hypothesisId: h.id, run: r });
    }
    h.queryIds = hRuns.map((r) => r.id);
  }

  // 4. Judge all open hypotheses in parallel; each sees only its own rows.
  await Promise.all(open.map(async (h) => {
    const hRuns = hRunsById.get(h.id)!;
    if (!hRuns.some((r) => r.ok && r.rows.length)) {
      h.verdict = "inconclusive";
      h.confidence = 0.1;
      h.claim = `Could not test "${h.statement}": no query returned data.`;
    } else {
      const judged = await llm<JudgeReply>([
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Hypothesis: ${h.statement}\nTest: ${h.test}\n\nResults:\n${hRuns.map(rowsForLlm).join("\n\n")}\n\n` +
            `Judge only from these rows. verdict is supported, refuted or inconclusive. claim is one plain sentence with the key numbers exactly as they appear in the rows. ` +
            `cites lists the query IDs the claim relies on.\nJSON: {"verdict":"...","confidence":0.0,"claim":"...","cites":["q_..."]}`,
        },
      ]);
      const check = checkSentence(judged.claim, judged.cites ?? [], runs);
      h.verdict = check.validCites.length ? judged.verdict : "inconclusive";
      // Confidence is capped when the claim's numbers don't trace to the rows.
      h.confidence = Math.max(0, Math.min(1, check.verified ? judged.confidence : Math.min(judged.confidence, 0.4)));
      h.claim = judged.claim;
      h.queryIds = check.validCites.length ? check.validCites : h.queryIds;
    }
  }));

  // 5. Remember, in plan order
  for (const h of open) {
    memory.remember({
      investigationId: id,
      entity,
      claim: h.claim,
      verdict: h.verdict,
      confidence: h.confidence,
      evidence: h.queryIds.map((qid) => {
        const r = runs.get(qid)!;
        return { queryId: qid, sql: r.sql, ok: r.ok, rowCount: r.rows.length };
      }),
    });
    onEvent?.({ type: "verdict", hypothesis: h });
  }

  // 6. Brief
  const reply = await llm<BriefReply>([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Question: ${question}\nEntity: ${entity}\n\nVerdicts:\n` +
        hypotheses.map((h) => `${h.id} [${h.verdict}, ${h.confidence.toFixed(2)}] ${h.statement}\n  claim: ${h.claim}\n  cites: ${(h.fromMemory ? [h.fromMemory] : h.queryIds).join(", ")}`).join("\n") +
        `\n\nEvidence:\n${[...runs.values()].filter((r) => r.ok).map(rowsForLlm).join("\n\n")}\n\n` +
        `Write a 3-6 sentence answer. Lead with the best-supported explanation, then what was ruled out. ` +
        `Every sentence must cite the query IDs or memory IDs it relies on, and use numbers exactly as they appear in the rows. ` +
        `gaps lists what the data could not answer.\nJSON: {"answer":[{"text":"...","cites":["q_..."]}],"gaps":["..."]}`,
    },
  ]);

  // Memory citations count when the memory itself was backed by queries.
  for (const r of recalled) if (r.queryIds.length) runs.set(r.memory.id, memoryRun(r));
  const answer: BriefSentence[] = (reply.answer ?? []).map((s) => {
    const cites = s.cites ?? [];
    return { text: s.text, cites, check: checkSentence(s.text, cites, runs) };
  });

  const queries = [...runs.values()].filter((r) => r.id.startsWith("q_"));
  const brief: Brief = {
    id,
    question,
    entity,
    answer,
    hypotheses,
    gaps: reply.gaps ?? [],
    queries,
    recalled,
    stats: {
      queriesRun: queries.length,
      queriesFailed: queries.filter((r) => !r.ok).length,
      hypothesesFromMemory: hypotheses.filter((h) => h.fromMemory).length,
      sentencesVerified: answer.filter((s) => s.check.verified).length,
      sentencesTotal: answer.length,
      ms: Date.now() - started,
    },
  };
  onEvent?.({ type: "brief", brief });
  return brief;
}

// A recalled memory acts as a one-row receipt so sentences can cite it.
// Numbers inside it were verified when it was first stored.
function memoryRun(r: Recalled): QueryRun {
  const nums = Object.fromEntries(
    [...r.memory.content.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((m, i) => [`n${i}`, Number(m[0].replace(/,/g, ""))]),
  );
  return {
    id: r.memory.id,
    sql: `-- H-MEM ${r.memory.id}: ${r.memory.source}`,
    ok: true,
    rows: [nums],
    columns: Object.keys(nums),
    ms: 0,
    at: new Date(r.memory.timestamp).toISOString(),
  };
}
