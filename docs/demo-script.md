# Demo video script (target 3 minutes, max 4)

Record with **Windows Game Bar**: press `Win + Alt + R` to start and stop (saves to `Videos\Captures`).
Or use OBS if you have it. Record the browser window at http://localhost:4321 only.

Before recording:
- Zetaris running (Docker Desktop open), app running (`npm start` in the receipts folder).
- Browser zoom 100%, close other tabs, full-screen the window (F11).
- Ask Claude to **clear the agent's memory** right before you record, so the first run starts fresh and the second run shows memory reuse.
- A full run takes about **5 minutes**: Zetaris queries are ~2 s each (cached), but each NVIDIA Nemotron step takes 30-90 s. Record everything, then **speed up the waiting parts** (4x-16x) when editing, or cut them. Add a small "sped up" caption.
- In the real run, 3 of 4 sentences were verified. The 4th was flagged because it quoted the "300 observed days" rule, which is not a number in the rows. **Point at it**: it shows the checker works.

---

## 0:00-0:20 Hook (on the empty start screen)
> "When a company's revenue jumps, the hard part isn't getting an answer, it's proving it. This is Receipts: an agent that explains *why* a number moved, and shows the receipts for every sentence."

## 0:20-0:45 The question (type it, press Investigate)
Question: **Why did revenue jump from 2024 to 2025?** (company: Dominion Energy)
> "Dominion Energy's SEC filings show revenue up from 14.46 to 16.51 billion dollars. I'll ask why."
Point at the status pills: "It's connected live to Zetaris, reasoning with NVIDIA Nemotron, with Meterless H-MEM as memory."

## 0:45-1:30 Watch it work (speed this up in editing)
> "First it recalls what it already knows. Then it proposes competing explanations: more generation, new capacity, weather, higher prices. Each one gets its own SQL, run live through Zetaris across three different systems: SEC filings over REST, power-plant data in Parquet on S3, and NOAA weather as CSV, joined through one Zetaris semantic model."
As stamps land: "Each cause is judged only from the rows that came back: supported, ruled out, or not enough data."

## 1:30-2:15 The answer and the receipts
> "Every sentence cites the query behind it, and the code, not the model, checks each one. A citation only counts if its query actually returned rows, and every number has to be in those rows."
Click a citation chip -> the drawer opens.
> "Here's the receipt: the exact SQL and rows. And I can re-run it live against Zetaris."
Click **Re-run live**, show "identical to the original receipt".
If any sentence shows **unverified**, point at it: "When a number doesn't trace back, it's flagged, not hidden."
Point at **What the data can't answer**: "It also says what it couldn't test, like the 2025 weather only covering 37 days."

## 2:15-2:45 Memory (Meterless H-MEM)
In the Memory panel, click **why?** on a finding.
> "Findings are stored in Meterless H-MEM with the query IDs that proved them, so here's why the agent believes this, and the full trust ledger."
Optional: click **correct**, type a short correction, save. "An analyst correction supersedes the finding without erasing it."

## 2:45-3:10 Ask again (shows memory reuse)
Ask the same question again (or a follow-up). Point at **"settled earlier · no new query"** and the stats row.
> "Ask again, and settled findings come from memory: fewer queries, less compute."

## 3:10-3:20 Close
> "Receipts: don't trust the answer, check the receipts. Built with Zetaris, Meterless H-MEM and NVIDIA Nemotron."
