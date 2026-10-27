// Zetaris client over the UI proxy route. Ported from the Deno helper in
// zetaris/getting-started (scripts/zetaris_api.ts) to Node fetch.
import { randomUUID, createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { requireEnv } from "../env.ts";

export interface QueryRun {
  id: string;          // stable hash of the SQL, used as the citation key
  sql: string;
  ok: boolean;
  rows: Record<string, unknown>[];
  columns: string[];
  error?: string;
  ms: number;
  at: string;
}

let cachedToken: string | undefined;

function baseUrl(): string {
  const url = (process.env.ZETARIS_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  if (!/^https?:\/\/[^/]+$/.test(url)) {
    throw new Error("ZETARIS_BASE_URL must be an HTTP(S) origin without a path.");
  }
  return url;
}

async function token(): Promise<string> {
  if (process.env.ZETARIS_API_KEY) return process.env.ZETARIS_API_KEY;
  if (cachedToken) return cachedToken;
  const res = await fetch(`${baseUrl()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-ID": randomUUID() },
    body: JSON.stringify({
      username: requireEnv("ZETARIS_USERNAME"),
      password: requireEnv("ZETARIS_PASSWORD"),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Zetaris login failed: HTTP ${res.status}`);
  const login = (await res.json()) as Record<string, unknown>;
  const t = login.idToken ?? login.token ?? login.accessToken ??
    JSON.stringify(login).match(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/)?.[0];
  if (typeof t !== "string" || !t) throw new Error("Zetaris login did not return an access token.");
  cachedToken = t;
  return t;
}

// Uses node:http rather than fetch: fetch gives up waiting for response
// headers after 5 minutes, and Lightning DDL over big S3 files can run longer.
export async function zetarisRequest(path: string, method = "GET", body?: unknown, timeoutMs = 120_000): Promise<unknown> {
  const orgId = requireEnv("ZETARIS_ORG_ID");
  const url = new URL(`${baseUrl()}${path}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await token()}`,
    "X-Org-ID": orgId,
    "X-Request-ID": randomUUID(),
    ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }),
  };
  const lib = url.protocol === "https:" ? https : http;
  const { status, contentType, text } = await new Promise<{ status: number; contentType: string; text: string }>((resolve, reject) => {
    const req = lib.request(url, { method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), text: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  if (status < 200 || status >= 300) {
    const detail = contentType.includes("text/html") ? "The server returned an HTML page; check the API route." : text.slice(0, 500);
    throw new Error(`${method} ${path} failed: HTTP ${status} ${detail}`);
  }
  return status === 204 || !text ? null : JSON.parse(text);
}

export function queryId(sql: string): string {
  return "q_" + createHash("sha256").update(sql.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 10);
}

// The response shape of run-query is not documented on the getting-started
// site, so normalise the common layouts and keep the raw payload otherwise.
export function normaliseResult(raw: unknown): { columns: string[]; rows: Record<string, unknown>[] } {
  const r = raw as Record<string, any>;
  // Zetaris run-query: {"headers":["one"],"data":[["1"]],"total":1,"timeUsed":847}, values as strings.
  if (Array.isArray(r?.headers) && Array.isArray(r?.data)) {
    const columns: string[] = r.headers.map(String);
    const rows = r.data.map((row: unknown[]) => Object.fromEntries(columns.map((c, i) => [c, typed(row[i])])));
    return { columns, rows };
  }
  const data = r?.data ?? r?.result ?? r;
  const rows = data?.rows ?? data?.records ?? (Array.isArray(data) ? data : undefined);
  const cols: string[] = (data?.columns ?? data?.schema ?? []).map((c: any) => (typeof c === "string" ? c : c?.name));
  if (Array.isArray(rows)) {
    const objects = rows.map((row: any) =>
      Array.isArray(row) ? Object.fromEntries(cols.map((c, i) => [c ?? `c${i}`, row[i]])) : row,
    );
    return { columns: cols.length ? cols : Object.keys(objects[0] ?? {}), rows: objects };
  }
  return { columns: ["raw"], rows: [{ raw }] };
}

// Zetaris errors carry a Java stack trace; keep the innermost message.
export function shortError(message: string): string {
  const head = message.split(/\\n\\tat |\n\tat /)[0];
  const parts = head.split(/Exception: /);
  return (parts.length > 1 ? parts[parts.length - 1] : head).replace(/\\n/g, " ").slice(0, 400);
}

// Numeric strings become numbers; IDs with leading zeros (CIKs) stay strings.
function typed(v: unknown): unknown {
  return typeof v === "string" && /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(v) ? Number(v) : v;
}

// Runs one Lightning SQL statement. Never throws on SQL errors: a failed
// query is evidence too ("this source could not answer").
export async function runQuery(sql: string, opts: { timeoutMs?: number } = {}): Promise<QueryRun> {
  const started = Date.now();
  // Zetaris takes one statement per call; models often end SQL with ";".
  const clean = sql.trim().replace(/;+\s*$/, "");
  const base = { id: queryId(clean), sql: clean, at: new Date().toISOString() };
  try {
    const limit = Number(process.env.ZETARIS_QUERY_LIMIT ?? "1000");
    const engineId = process.env.ZETARIS_ENGINE_ID;
    const raw = await zetarisRequest("/api/proxy/sql-editor/sqls/run-query", "POST", {
      sql: base.sql,
      limit,
      ...(engineId ? { engineId } : {}),
    }, opts.timeoutMs);
    const { columns, rows } = normaliseResult(raw);
    return { ...base, ok: true, columns, rows, ms: Date.now() - started };
  } catch (err) {
    return { ...base, ok: false, columns: [], rows: [], error: shortError((err as Error).message), ms: Date.now() - started };
  }
}
