// Web app: serves the page in public/ and a small JSON API. Investigations
// stream to the browser as server-sent events so each step shows as it lands.
//   npm start            -> live Zetaris
//   npm start -- --offline -> sample rows (never real claims)
import "./env.ts";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { investigate, type Llm } from "./agent/investigate.ts";
import { CATALOG, KNOWN_CIKS } from "./agent/catalog.ts";
import { chatJson, model } from "./llm/nemotron.ts";
import { FindingsMemory } from "./memory/findings.ts";
import { runQuery, type QueryRun } from "./zetaris/client.ts";
import { runOffline } from "./zetaris/offline.ts";

const PORT = Number(process.env.PORT ?? 4321);
const forceOffline = process.argv.includes("--offline") || process.env.RECEIPTS_OFFLINE === "1";
const PUBLIC = path.resolve("public");

const memories = {
  live: new FindingsMemory({ dir: process.env.HMEM_DIR ?? "data/memory" }),
  offline: new FindingsMemory({ dir: "data/memory/offline" }),
};
const llm: Llm = (messages) => chatJson(messages);
// Every query result seen this session, so receipts can be reopened.
const receipts = new Map<string, QueryRun>();

let zetarisOk: boolean | undefined;
async function checkZetaris(): Promise<boolean> {
  if (forceOffline) return false;
  const r = await runQuery("SELECT 1");
  zetarisOk = r.ok;
  return r.ok;
}

function mode(url: URL): "live" | "offline" {
  return forceOffline || url.searchParams.get("mode") === "offline" ? "offline" : "live";
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody<T>(req: http.IncomingMessage): Promise<T> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}") as T;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(url: URL, res: http.ServerResponse): void {
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/api/status") {
    const ok = await checkZetaris();
    return json(res, 200, {
      zetaris: forceOffline ? "offline-mode" : ok ? "connected" : "unreachable",
      forceOffline,
      model: model(),
      entities: Object.keys(KNOWN_CIKS).filter((e) => !e.startsWith("sample")).map(titleCase),
      sources: [...new Set(CATALOG.map((t) => t.source))],
    });
  }

  if (p === "/api/investigate" && req.method === "GET") {
    const question = url.searchParams.get("question")?.trim();
    const entity = url.searchParams.get("entity")?.trim() || "Dominion Energy";
    if (!question) return json(res, 400, { error: "question is required" });
    const m = mode(url);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("mode", { mode: m });
    try {
      await investigate({
        question,
        entity: m === "offline" ? "SAMPLE Utility Co" : entity,
        llm,
        run: m === "offline" ? runOffline : runQuery,
        memory: memories[m],
        onEvent: (e) => {
          if (e.type === "query") receipts.set(e.run.id, e.run);
          if (e.type === "brief") for (const q of e.brief.queries) receipts.set(q.id, q);
          send(e.type, e);
        },
      });
    } catch (err) {
      send("failed", { error: (err as Error).message });
    }
    send("done", {});
    res.end();
    return;
  }

  if (p.startsWith("/api/receipt/")) {
    const r = receipts.get(decodeURIComponent(p.slice("/api/receipt/".length)));
    return r ? json(res, 200, r) : json(res, 404, { error: "receipt not in this session" });
  }

  if (p === "/api/rerun" && req.method === "POST") {
    const { sql } = await readBody<{ sql?: string }>(req);
    if (!sql || !/^\s*(select|with)\b/i.test(sql)) return json(res, 400, { error: "only SELECT queries can be re-run" });
    const r = mode(url) === "offline" ? await runOffline(sql) : await runQuery(sql);
    receipts.set(r.id, r);
    return json(res, 200, r);
  }

  if (p === "/api/memory" && req.method === "GET") {
    const m = mode(url);
    const entity = m === "offline" ? "SAMPLE Utility Co" : url.searchParams.get("entity") ?? undefined;
    return json(res, 200, memories[m].list(entity));
  }

  const explain = p.match(/^\/api\/memory\/([^/]+)\/explain$/);
  if (explain) {
    try {
      return json(res, 200, memories[mode(url)].explain(decodeURIComponent(explain[1])));
    } catch (err) {
      return json(res, 404, { error: (err as Error).message });
    }
  }

  const correct = p.match(/^\/api\/memory\/([^/]+)\/correct$/);
  if (correct && req.method === "POST") {
    const { text, analyst } = await readBody<{ text?: string; analyst?: string }>(req);
    if (!text?.trim()) return json(res, 400, { error: "correction text is required" });
    try {
      const fixed = memories[mode(url)].correct(decodeURIComponent(correct[1]), text.trim(), analyst?.trim() || "analyst");
      return json(res, 200, fixed);
    } catch (err) {
      return json(res, 404, { error: (err as Error).message });
    }
  }

  if (p.startsWith("/api/")) return json(res, 404, { error: "unknown endpoint" });
  serveStatic(url, res);
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    });
  })
  .listen(PORT, () => {
    console.log(`Receipts on http://localhost:${PORT}${forceOffline ? " (offline sample mode)" : ""}`);
  });
