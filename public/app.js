// Receipts front end. No framework: one EventSource per investigation, and
// every model-written string goes into the page through textContent.

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

const state = {
  mode: "live",
  entity: "Dominion Energy",
  labels: new Map(),   // query/memory ID -> "Q1" / "M1"
  receipts: new Map(), // query ID -> QueryRun
  hyps: new Map(),     // hypothesis ID -> card element
  source: null,
};

const EXAMPLES = [
  "Why did revenue change from 2023 to 2025?",
  "Did generation capacity growth drive revenue?",
  "Is weather a plausible driver of the revenue change?",
];

const VERDICT_TEXT = { supported: "Supported", refuted: "Ruled out", inconclusive: "Not enough data", pending: "Testing" };

// ---------- status ----------

async function loadStatus() {
  const s = await fetch("/api/status").then((r) => r.json()).catch(() => null);
  const pill = (id, cls, text) => { const p = $(id); p.className = `pill ${cls}`; p.lastChild.textContent = text; };
  if (!s) { pill("#st-zetaris", "bad", "Server unreachable"); return; }
  state.mode = s.zetaris === "connected" ? "live" : "offline";
  pill("#st-zetaris", s.zetaris === "connected" ? "ok" : "warn",
    s.zetaris === "connected" ? "Zetaris live" : s.forceOffline ? "Zetaris: sample mode" : "Zetaris unreachable: sample mode");
  pill("#st-model", "ok", s.model.replace(/^nvidia\//, ""));
  $("#offline-banner").hidden = state.mode === "live";

  const select = $("#entity");
  select.replaceChildren(...(state.mode === "live" ? s.entities : ["SAMPLE Utility Co"]).map((e) => el("option", { value: e }, e)));
  state.entity = select.value;
  loadMemory();
}

// ---------- ask ----------

function setupAsk() {
  $("#examples").append(...EXAMPLES.map((q) => el("button", { type: "button", onclick: () => { $("#question").value = q; $("#question").focus(); } }, q)));
  $("#entity").addEventListener("change", (e) => { state.entity = e.target.value; loadMemory(); });
  $("#ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#question").value.trim() || $("#question").placeholder;
    $("#question").value = q;
    start(q);
  });
}

const STEPS = [
  ["recall", "Recall memory"],
  ["plan", "Hypothesise"],
  ["query", "Query Zetaris"],
  ["judge", "Judge"],
  ["brief", "Write + check"],
];

function setStep(key) {
  const idx = STEPS.findIndex(([k]) => k === key);
  document.querySelectorAll(".step").forEach((s, i) => {
    s.classList.toggle("done", i < idx || key === "end");
    s.classList.toggle("active", i === idx);
  });
}

function start(question) {
  state.source?.close();
  state.labels.clear();
  state.hyps.clear();
  $("#empty").hidden = true;
  $("#run").hidden = false;
  $("#brief").hidden = true;
  $("#hyps").replaceChildren();
  $("#steps").replaceChildren(...STEPS.map(([k, t]) => el("span", { class: "step", "data-k": k }, t)));
  setStep("recall");
  $("#go").disabled = true;
  $("#go").textContent = "Investigating…";

  const params = new URLSearchParams({ question, entity: state.entity, mode: state.mode });
  const es = new EventSource(`/api/investigate?${params}`);
  state.source = es;
  const on = (name, fn) => es.addEventListener(name, (ev) => fn(JSON.parse(ev.data)));

  on("recalled", (e) => {
    for (const r of e.items) label(r.memory.id, "M");
    setStep("plan");
  });
  on("planned", (e) => {
    for (const h of e.hypotheses) addHyp(h);
    setStep("query");
  });
  on("query", (e) => {
    state.receipts.set(e.run.id, e.run);
    addQuery(e.hypothesisId, e.run);
  });
  on("verdict", (e) => {
    setStep("judge");
    landVerdict(e.hypothesis);
  });
  on("brief", (e) => {
    setStep("brief");
    renderBrief(e.brief);
    setStep("end");
    loadMemory();
  });
  on("failed", (e) => {
    $("#hyps").prepend(el("div", { class: "error" }, `Investigation failed: ${e.error}`));
  });
  es.addEventListener("done", () => finish());
  es.onerror = () => finish();
}

function finish() {
  state.source?.close();
  state.source = null;
  $("#go").disabled = false;
  $("#go").textContent = "Investigate";
}

function label(id, prefix) {
  if (!state.labels.has(id)) {
    const n = [...state.labels.values()].filter((l) => l.startsWith(prefix)).length + 1;
    state.labels.set(id, `${prefix}${n}`);
  }
  return state.labels.get(id);
}

// ---------- hypotheses ----------

function addHyp(h) {
  const stamp = el("span", { class: `stamp ${h.fromMemory ? "supported" : "pending"}` }, h.fromMemory ? "From memory" : VERDICT_TEXT.pending);
  const card = el("div", { class: "hyp", id: `hyp-${h.id}` },
    el("div", { class: "hyp-top" },
      el("div", {},
        el("div", { class: "hyp-id" }, h.id.toUpperCase()),
        el("h3", {}, h.statement),
        h.fromMemory ? el("span", { class: "from-mem" }, `settled earlier · ${label(h.fromMemory, "M")} · no new query`) : null,
      ),
      stamp,
    ),
    el("div", { class: "queries" }),
    el("p", { class: "claim", hidden: true }),
    el("div", { class: "conf", hidden: true }, el("span", { class: "bar" }, el("b", { style: "width:0" })), el("span", { class: "pct" })),
  );
  state.hyps.set(h.id, card);
  $("#hyps").append(card);
}

function addQuery(hypId, run) {
  const card = state.hyps.get(hypId);
  if (!card) return;
  const q = label(run.id, "Q");
  card.querySelector(".queries").append(
    el("button", { class: `qchip ${run.ok ? "" : "fail"}`, onclick: () => openReceipt(run.id) },
      q, el("span", { class: "n" }, run.ok ? `${run.rows.length} rows · ${run.ms} ms` : "failed")),
  );
}

function landVerdict(h) {
  const card = state.hyps.get(h.id);
  if (!card) return;
  const stamp = card.querySelector(".stamp");
  stamp.className = `stamp ${h.verdict} landed`;
  stamp.textContent = VERDICT_TEXT[h.verdict];
  const claim = card.querySelector(".claim");
  claim.hidden = !h.claim;
  claim.textContent = h.claim;
  const conf = card.querySelector(".conf");
  conf.hidden = false;
  conf.querySelector("b").style.width = `${Math.round(h.confidence * 100)}%`;
  conf.querySelector(".pct").textContent = `confidence ${Math.round(h.confidence * 100)}%`;
  if (h.fromMemory) {
    const qs = card.querySelector(".queries");
    qs.replaceChildren(el("button", { class: "qchip", onclick: () => openMemory(h.fromMemory) }, label(h.fromMemory, "M"), el("span", { class: "n" }, "memory receipt")));
  }
}

// ---------- brief ----------

function highlightNumbers(text, check) {
  const bad = check.numbers.filter((n) => !n.found).map((n) => n.text);
  if (!bad.length) return [text];
  const parts = [];
  let rest = text;
  for (const b of bad) {
    const i = rest.indexOf(b);
    if (i < 0) continue;
    parts.push(rest.slice(0, i), el("mark", { class: "bad-num", title: "Not found in the cited rows" }, b));
    rest = rest.slice(i + b.length);
  }
  parts.push(rest);
  return parts;
}

function citeChip(id, alive) {
  const isMem = !id.startsWith("q_");
  const text = state.labels.get(id) ?? (isMem ? label(id, "M") : label(id, "Q"));
  return el("button", {
    class: `cite ${alive ? "" : "dead"}`,
    title: alive ? "Open receipt" : "This citation did not hold up",
    onclick: () => (isMem ? openMemory(id) : openReceipt(id)),
  }, text);
}

function renderBrief(b) {
  for (const q of b.queries) state.receipts.set(q.id, q);
  $("#brief").hidden = false;
  $("#brief-q").textContent = b.question;
  $("#brief-body").replaceChildren(...b.answer.map((s) =>
    el("div", { class: "sentence" },
      el("p", {}, ...highlightNumbers(s.text, s.check),
        el("span", { class: "cites" }, ...s.check.validCites.map((id) => citeChip(id, true)), ...s.check.droppedCites.map((id) => citeChip(id, false)))),
      s.check.verified ? el("span", { class: "badge ok" }, "✓ verified") : el("span", { class: "badge no" }, "unverified"),
    ),
  ));
  $("#brief-gaps").replaceChildren(...(b.gaps.length ? [el("h4", {}, "What the data can't answer"), el("ul", {}, ...b.gaps.map((g) => el("li", {}, g)))] : []));
  const st = b.stats;
  const stat = (k, v) => el("div", {}, el("dt", {}, k), el("dd", {}, v));
  $("#brief-stats").replaceChildren(
    stat("Queries run", st.queriesRun),
    stat("From memory", st.hypothesesFromMemory),
    stat("Verified", `${st.sentencesVerified}/${st.sentencesTotal}`),
    stat("Time", `${(st.ms / 1000).toFixed(0)}s`),
  );
  $("#brief").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- receipt drawer ----------

function openDrawer(...content) {
  $("#drawer-body").replaceChildren(...content.filter((c) => c != null && c !== false));
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("open");
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("open");
}

const KW = /\b(SELECT|FROM|WHERE|JOIN|LEFT|ON|GROUP BY|ORDER BY|AS|AND|OR|SUM|AVG|COUNT|MAX|MIN|WITH|LIMIT|BETWEEN|IN|CASE|WHEN|THEN|END|NULLIF|DISTINCT)\b/gi;
function sqlBlock(sql) {
  const pre = el("pre", { class: "sql" });
  let last = 0;
  for (const m of sql.matchAll(KW)) {
    pre.append(sql.slice(last, m.index), el("span", { class: "kw" }, m[0]));
    last = m.index + m[0].length;
  }
  pre.append(sql.slice(last));
  return pre;
}

function rowsTable(run) {
  if (!run.ok) return el("div", { class: "error" }, run.error ?? "Query failed");
  if (!run.rows.length) return el("p", { class: "muted" }, "No rows returned.");
  const cols = run.columns.length ? run.columns : Object.keys(run.rows[0]);
  const isYear = (v) => Number.isInteger(v) && v >= 1900 && v <= 2100;
  const fmt = (v) => typeof v === "number" && !isYear(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v == null ? "—" : String(v);
  return el("div", { class: "tablewrap" },
    el("table", {},
      el("thead", {}, el("tr", {}, ...cols.map((c) => el("th", {}, c)))),
      el("tbody", {}, ...run.rows.slice(0, 50).map((r) => el("tr", {}, ...cols.map((c) => el("td", { class: typeof r[c] === "number" ? "num" : "" }, fmt(r[c])))))),
    ));
}

async function openReceipt(id) {
  let run = state.receipts.get(id);
  if (!run) run = await fetch(`/api/receipt/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null));
  if (!run) return openDrawer(el("p", { class: "error" }, "Receipt not available in this session."));
  const result = el("div", {}, rowsTable(run));
  const note = el("p", { class: "muted" });
  const rerun = el("button", { class: "btn", onclick: async () => {
    rerun.disabled = true; rerun.textContent = "Running…";
    const fresh = await fetch(`/api/rerun?mode=${state.mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: run.sql }) }).then((r) => r.json());
    result.replaceChildren(rowsTable(fresh));
    const same = JSON.stringify(fresh.rows) === JSON.stringify(run.rows);
    note.textContent = fresh.ok ? `Re-ran live in ${fresh.ms} ms: ${fresh.rows.length} rows, ${same ? "identical to the original receipt" : "different from the original receipt"}.` : "Re-run failed.";
    rerun.disabled = false; rerun.textContent = "Re-run live";
  } }, "Re-run live");
  openDrawer(
    el("span", { class: "kicker" }, "Receipt"),
    el("h3", {}, `${label(id, "Q")} · ${run.ok ? `${run.rows.length} rows` : "failed"}`),
    el("div", { class: "meta" }, `${id} · ran ${new Date(run.at).toLocaleString()} · ${run.ms} ms${state.mode === "offline" ? " · SAMPLE DATA" : " · via Zetaris"}`),
    sqlBlock(run.sql),
    result,
    el("div", { class: "actions" }, rerun),
    note,
  );
}

// ---------- memory ----------

async function loadMemory() {
  const items = await fetch(`/api/memory?mode=${state.mode}&entity=${encodeURIComponent(state.entity)}`).then((r) => r.json()).catch(() => []);
  const live = items.filter((m) => !m.memory.supersededBy).length;
  const p = $("#st-memory");
  p.className = "pill ok";
  p.lastChild.textContent = `H-MEM · ${live} finding${live === 1 ? "" : "s"}`;
  const list = $("#mem-list");
  if (!items.length) return list.replaceChildren(el("p", { class: "mem-empty" }, "Nothing yet. Findings appear here after the first investigation."));
  list.replaceChildren(...items.slice(0, 30).map((m) =>
    el("div", { class: `mem ${m.memory.supersededBy ? "superseded" : ""}` },
      el("span", { class: `dot ${m.verdict ?? ""}` }),
      el("div", { class: "mem-text" }, m.memory.content),
      el("div", { class: "mem-meta" },
        el("span", {}, VERDICT_TEXT[m.verdict] ?? "note"),
        el("span", {}, `confidence ${Math.round(m.memory.confidence * 100)}%`),
        el("span", {}, `${m.queryIds.length} receipt${m.queryIds.length === 1 ? "" : "s"}`),
        el("button", { onclick: () => openMemory(m.memory.id) }, "why?"),
        m.memory.supersededBy ? el("span", {}, "corrected") : el("button", { onclick: () => openCorrect(m.memory) }, "correct"),
      ),
    )));
}

const ACTION_TEXT = {
  create: "Learned", read: "Recalled", update: "Updated", feedback: "Feedback", promote: "Promoted", demote: "Demoted",
  conflict_detected: "Conflict found", conflict_resolved: "Conflict resolved", delete: "Deleted",
};

async function openMemory(id) {
  const x = await fetch(`/api/memory/${encodeURIComponent(id)}/explain?mode=${state.mode}`).then((r) => (r.ok ? r.json() : null));
  if (!x) return openDrawer(el("p", { class: "error" }, "Memory not found."));
  const m = x.memory;
  openDrawer(
    el("span", { class: "kicker" }, "Why the agent believes this"),
    el("h3", {}, m.content),
    el("div", { class: "meta" }, `${id} · ${m.source} · confidence ${Math.round(m.confidence * 100)}% · ${m.layer.replace("_", " ")}`),
    x.correctedBy ? el("p", { class: "error" }, `Corrected by ${x.correctedBy.provenance.label.replace(/^Corrected by /, "")}: ${x.correctedBy.content}`) : null,
    x.queryIds.length ? el("div", {}, el("h4", { class: "kicker" }, "Backed by"), el("div", { class: "queries" }, ...x.queryIds.map((q) => el("button", { class: "qchip", onclick: () => openReceipt(q) }, label(q, "Q"), el("span", { class: "n" }, q))))) : el("p", { class: "muted" }, "No query receipts: this came from an analyst."),
    el("h4", { class: "kicker", style: "margin-top:18px" }, "Trust ledger"),
    el("ul", { class: "ledger" }, ...x.ledger.map((e) => el("li", {},
      el("div", { class: "act" }, ACTION_TEXT[e.action] ?? e.action, " · ", e.actor),
      el("div", { class: "when" }, new Date(e.timestamp).toLocaleString(),
        e.previousState?.confidence != null && e.newState?.confidence != null ? ` · confidence ${Math.round(e.previousState.confidence * 100)}% → ${Math.round(e.newState.confidence * 100)}%` : ""),
    ))),
  );
}

function openCorrect(memory) {
  const text = el("textarea", { placeholder: "What is actually true, and how do you know?" });
  const who = el("input", { placeholder: "Your name or email", style: "width:100%;margin-top:8px;padding:9px;border-radius:8px;border:1px solid var(--rule-strong);background:var(--paper);color:var(--ink);font:inherit" });
  const save = el("button", { class: "btn", onclick: async () => {
    const r = await fetch(`/api/memory/${encodeURIComponent(memory.id)}/correct?mode=${state.mode}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text.value, analyst: who.value }),
    });
    if (!r.ok) return save.after(el("p", { class: "error" }, (await r.json()).error));
    closeDrawer();
    loadMemory();
  } }, "Save correction");
  openDrawer(
    el("span", { class: "kicker" }, "Correct a finding"),
    el("h3", {}, memory.content),
    el("p", { class: "muted" }, "The original stays on the trust ledger, marked as superseded. Future investigations use your correction instead."),
    text, who,
    el("div", { class: "actions" }, save, el("button", { class: "btn ghost", onclick: closeDrawer }, "Cancel")),
  );
}

// ---------- boot ----------

$("#drawer-close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
setupAsk();
loadStatus();
