# Receipts

**An investigator agent that answers "why" questions over live enterprise data, and shows the receipts for every claim.**

Built for the [Open Agent Hackathon 2026](https://hackathon.genai.works/event/open-agent-hackathon-2026), Track 02: *The Agent That Can Explain Why*.

> Work in progress. Sections marked TODO are filled in as the build lands.

## The problem

When a number moves (revenue, cost, demand), an analyst spends days pulling data from separate systems to find out why, and the final answer rarely shows which data backs which sentence. Generic AI assistants answer faster but invent causes and can't show their working.

## What Receipts does

1. You ask a "why" question about a company, e.g. *"Why did Dominion Energy's revenue change from 2023 to 2025?"*
2. The agent proposes competing hypotheses (demand and weather, generation capacity, pricing, and so on).
3. For each one it writes SQL, runs it live across sources federated by **Zetaris** (SEC EDGAR filings, PUDL power-plant data, NOAA weather), and rules it **supported**, **refuted** or **inconclusive**.
4. It returns a short brief where **every sentence links to the exact query and rows behind it**, plus what it ruled out and what the data can't answer.
5. Verified findings are kept in **H-MEM** memory with their query provenance, so the next question about the same company reuses them instead of re-querying, and an analyst's correction is recorded on an append-only trust ledger.

## Stack

| Piece | Role |
|---|---|
| Zetaris AI Data Harness | Federated, live SQL across SEC, PUDL and NOAA sources without copying data |
| Meterless H-MEM engine | Investigation memory with provenance, recall, corrections and trust ledger (`src/engines/hmem`, conformance suite passing) |
| NVIDIA Nemotron (build.nvidia.com) | Hypothesis planning, SQL writing and verdicts |
| Claude Code | AI coding tool used to build the project |

## Run it

Requires Node 20+.

```bash
npm install
cp .env.example .env.local   # then fill in Zetaris and NVIDIA settings
npm test                     # unit tests
npm run conformance          # official H-MEM conformance suite
npm run zetaris:check        # read-only Zetaris connection check
npm run nemotron:check       # NVIDIA key and model check
```

## Layout

| Path | What it is |
|---|---|
| `src/zetaris/client.ts` | Zetaris client (UI proxy route), one statement per call, failures kept as evidence |
| `src/llm/nemotron.ts` | Nemotron chat client (OpenAI-compatible) |
| `src/memory/findings.ts` | Investigation memory on top of H-MEM |
| `src/engines/hmem/` | Meterless H-MEM engine (Apache-2.0) |
| `conformance/hmem/` | Official H-MEM conformance suite |

## Sponsor technology

TODO: how Zetaris, Meterless and NVIDIA are each used, and what is unique about it.

## Pre-existing components

Declared per the hackathon rules: the H-MEM engine in `src/engines/hmem/` and its conformance suite come from the Meterless repository (Apache-2.0). The Zetaris client is adapted from `zetaris/getting-started`. Everything else was written during the build window.

## License

Apache-2.0
