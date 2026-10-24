// Zetaris client over the UI proxy route. Ported from the Deno helper in
// zetaris/getting-started (scripts/zetaris_api.ts) to Node fetch.
import { randomUUID, createHash } from "node:crypto";
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

export async function zetarisRequest(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const orgId = requireEnv("ZETARIS_ORG_ID");
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "X-Org-ID": orgId,
      "X-Request-ID": randomUUID(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = res.headers.get("content-type")?.includes("text/html")
      ? "The server returned an HTML page; check the API route."
      : (await res.text()).slice(0, 500);
    throw new Error(`${method} ${path} failed: HTTP ${res.status} ${detail}`);
  }
  return res.status === 204 ? null : await res.json();
}

export function queryId(sql: string): string {
  return "q_" + createHash("sha256").update(sql.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 10);
}

// The response shape of run-query is not documented on the getting-started
// site, so normalise the common layouts and keep the raw payload otherwise.
export function normaliseResult(raw: unknown): { columns: string[]; rows: Record<string, unknown>[] } {
  const r = raw as Record<string, any>;
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

// Runs one Lightning SQL statement. Never throws on SQL errors: a failed
// query is evidence too ("this source could not answer").
export async function runQuery(sql: string): Promise<QueryRun> {
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
    });
    const { columns, rows } = normaliseResult(raw);
    return { ...base, ok: true, columns, rows, ms: Date.now() - started };
  } catch (err) {
    return { ...base, ok: false, columns: [], rows: [], error: (err as Error).message, ms: Date.now() - started };
  }
}
