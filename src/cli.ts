// Ask a question from the terminal:
//   npm run ask -- "Why did revenue rise from 2023 to 2025?" --entity "Dominion Energy" [--offline]
import "./env.ts";
import { investigate, type Llm } from "./agent/investigate.ts";
import { chatJson } from "./llm/nemotron.ts";
import { FindingsMemory } from "./memory/findings.ts";
import { runQuery } from "./zetaris/client.ts";
import { runOffline } from "./zetaris/offline.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const offline = args.includes("--offline") && (args.splice(args.indexOf("--offline"), 1), true);
const entity = flag("entity") ?? "Dominion Energy";
const question = args.join(" ").trim();
if (!question) {
  console.error('Usage: npm run ask -- "Why did ...?" --entity "Company" [--offline]');
  process.exit(1);
}

const llm: Llm = (messages) => chatJson(messages, { maxTokens: 4096 });
const memory = new FindingsMemory({ dir: process.env.HMEM_DIR ?? "data/memory" });
if (offline) console.log("OFFLINE: sample rows, not real data\n");

const brief = await investigate({
  question,
  entity,
  llm,
  run: offline ? runOffline : runQuery,
  memory,
  onEvent: (e) => {
    if (e.type === "recalled") console.log(`memory: ${e.items.length} settled finding(s) recalled`);
    if (e.type === "planned") for (const h of e.hypotheses) console.log(`  ${h.id} ${h.statement}${h.fromMemory ? `  (from memory ${h.fromMemory})` : ""}`);
    if (e.type === "query") console.log(`    ${e.run.ok ? "ok  " : "FAIL"} ${e.run.id} ${e.run.rows.length} rows ${e.run.ms} ms`);
    if (e.type === "verdict") console.log(`  ${e.hypothesis.id} -> ${e.hypothesis.verdict} (${e.hypothesis.confidence.toFixed(2)})`);
  },
});

console.log(`\n${brief.question}\n`);
for (const s of brief.answer) {
  const flagText = s.check.verified ? "verified" : `UNVERIFIED${s.check.numbers.filter((n) => !n.found).map((n) => ` ${n.text}`).join("")}`;
  console.log(`- ${s.text} [${s.cites.join(", ")}] (${flagText})`);
}
if (brief.gaps.length) console.log(`\nGaps:\n${brief.gaps.map((g) => `- ${g}`).join("\n")}`);
const st = brief.stats;
console.log(`\n${st.queriesRun} queries (${st.queriesFailed} failed), ${st.hypothesesFromMemory} hypotheses from memory, ${st.sentencesVerified}/${st.sentencesTotal} sentences verified, ${(st.ms / 1000).toFixed(1)} s`);
