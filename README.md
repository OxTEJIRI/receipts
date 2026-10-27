# Receipts

**An investigator agent that answers "why" questions over live enterprise data, and shows the receipts for every claim.**

Built for the [Open Agent Hackathon 2026](https://hackathon.genai.works/event/open-agent-hackathon-2026), Track 02: *The Agent That Can Explain Why*.

## The problem

When a number moves (revenue, cost, demand), an analyst spends days pulling data from separate systems to find out why, and the final answer rarely shows which data backs which sentence. Generic AI assistants answer faster, but they invent causes and can't show their working.

**Who it's for:** financial and operations analysts, auditors and investor-relations teams who have to explain a moving number and defend the explanation.

## What Receipts does

1. You ask a "why" question about a company, e.g. *"Why did Dominion Energy's revenue change from 2023 to 2025?"*
2. **Recall.** It checks H-MEM memory for findings already settled about that company.
3. **Hypothesise.** It proposes competing explanations (generation volume, capacity growth, weather, pricing...), including ones the data might refute.
4. **Query.** For each open hypothesis it writes SQL and runs it live through **Zetaris** across SEC EDGAR filings, PUDL power-plant data and NOAA weather, without copying any data. A failed query gets one repair attempt; anything other than a `SELECT` is refused.
5. **Judge.** Each hypothesis is ruled **supported**, **ruled out** or **not enough data** using only the rows that came back. All hypotheses are judged in parallel.
6. **Check.** Code, not the model, checks every receipt: a citation must point at a query that actually returned rows, and every number in a sentence must appear in the cited rows (or be a difference or percent change between two cells), allowing for how it was rounded. Anything that fails is shown as **unverified**, with the bad number highlighted.
7. **Remember.** Verdicts are stored in H-MEM with the query IDs that proved them. The next question about the same company reuses settled findings instead of re-querying, and an analyst's correction supersedes a finding without erasing it.

## Sponsor technology

### Zetaris: one SQL surface over three live sources
- Three different kinds of source are registered as Lightning tables: a **REST** source (SEC EDGAR XBRL company facts), **Parquet on public S3** (PUDL's SEC-to-EIA utility crosswalk and yearly generator data) and **CSV on public S3** (NOAA GHCN-Daily weather for VA, NC and SC).
- A **USL model** (`company`, `revenue_year`, `utility_state_year`, `weather_period`) links them through foreign keys, so the agent writes ordinary SQL joins across sources that live in different systems. `npm run zetaris:setup` builds it in 19 idempotent steps with a resume point.
- We extended the getting-started guide's two-month weather window to **per-state, per-year weather for 2022-2025**, so weather can be compared with revenue year by year.
- Every query runs live through the Zetaris API, and each result becomes a receipt the user can open and **re-run live** from the UI. Identical SQL across hypotheses runs once, and settled findings come from memory, which **cuts repeat compute**: in testing, the second investigation of the same question ran 2 queries instead of 4.

### Meterless: the H-MEM engine as investigation memory
- `src/engines/hmem/` is the Meterless H-MEM engine. The official conformance suite passes **13/13** (`npm run conformance`).
- `src/memory/findings.ts` turns it into investigation memory: each finding is stored with its verdict, confidence and the **Zetaris query IDs in its provenance**. Recall is filtered per company, and settled findings are passed to the planner so it can skip hypotheses that are already answered.
- **Analyst corrections** use H-MEM's `supersedes`/`supersededBy` and feedback deltas. The original is never overwritten, and the **trust ledger** shows when a fact was learned, recalled, marked helpful or corrected, and by whom. The UI's "why?" button shows this trail.
- Findings with no successful query behind them are capped at 0.3 confidence and kept in short-term memory.

### NVIDIA: Nemotron 3 Ultra as the reasoning model
- `nvidia/nemotron-3-ultra-550b-a55b` via build.nvidia.com does the planning, SQL writing, SQL repair, judging and brief writing. In our comparison it was the fastest model tested and wrote the most correct SQL.
- Replies are parsed as JSON, with one shorter retry when a reply is cut off.

### AI coding tool
Built with Claude Code (the organisers made Cursor optional on Oct 23).

## What's unique
- **Receipts are checked by code, not trusted from the model.** Most "cite your sources" agents let the model pick its citations. Receipts throws out citations to queries that failed or never ran, and flags any number that isn't in the cited rows.
- **It explains what it ruled out, not only what it found.** Competing hypotheses are tested side by side, and the answer says which ones the data refuted or couldn't test.
- **Memory with provenance makes it cheaper over time.** Verified findings carry their query IDs, so reusing them is safe and auditable.

## Run it

Requires Node 20+ and a Zetaris instance (local Docker or AWS, see [zetaris/getting-started](https://zetaris.github.io/getting-started)).

```bash
npm install
cp .env.example .env.local   # fill in Zetaris, NVIDIA and SEC contact settings
npm run zetaris:check        # read-only connection check
npm run zetaris:setup        # dry run of the data load; add -- --apply to run it
npm start                    # web app on http://localhost:4321
npm run start:offline        # same app on clearly labelled sample rows, no Zetaris needed
npm test                     # unit tests
npm run conformance          # official H-MEM conformance suite
npm run ask -- "Why did revenue change from 2023 to 2025?" --entity "Dominion Energy"
```

## Layout

| Path | What it is |
|---|---|
| `src/agent/investigate.ts` | The investigation loop: recall, hypothesise, query, judge, remember, brief |
| `src/agent/verify.ts` | Receipt checks for citations and numbers |
| `src/agent/catalog.ts` | The tables the planner may use |
| `src/zetaris/client.ts` | Zetaris client: one statement per call, failures kept as evidence |
| `src/zetaris/setup.ts` | Builds the SEC + PUDL + NOAA sources and USL model |
| `src/llm/nemotron.ts` | Nemotron client (OpenAI-compatible) |
| `src/memory/findings.ts` | Investigation memory on top of H-MEM |
| `src/engines/hmem/` | Meterless H-MEM engine (Apache-2.0) |
| `src/server.ts`, `public/` | Web app with live event stream |
| `conformance/hmem/` | Official H-MEM conformance suite |

## Limits
- One company (Dominion Energy, CIK 0000715957) is wired into the USL model. Adding another means one more SEC REST table and its CIK.
- Weather comes from one airport station per state, which is a proxy for service-territory weather.
- PUDL's SEC-to-EIA crosswalk is probabilistic and can miss or mis-match utilities.

## Pre-existing components

Declared per the hackathon rules: the H-MEM engine in `src/engines/hmem/` and its conformance suite come from the Meterless repository (Apache-2.0). The Zetaris client and the SQL in `src/zetaris/setup.ts` are adapted from `zetaris/getting-started`. Everything else was written during the build window.

## License

Apache-2.0
