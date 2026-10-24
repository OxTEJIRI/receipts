// Offline runner for development before a Zetaris instance is up. It does
// not execute SQL: it returns the rows of whichever catalog table the query
// names. The numbers are SAMPLE values for wiring and UI work only, never
// for the demo or any claim about a real company.
import { queryId, type QueryRun } from "./client.ts";

const SAMPLE: Record<string, Record<string, unknown>[]> = {
  company: [{ cik: "0000715957", company_name: "SAMPLE Utility Co" }],
  revenue_year: [
    { revenue_year_key: "0000715957_2023", cik: "0000715957", report_year: 2023, revenue_usd: 10_000_000_000, accession_number: "SAMPLE-23" },
    { revenue_year_key: "0000715957_2024", cik: "0000715957", report_year: 2024, revenue_usd: 10_800_000_000, accession_number: "SAMPLE-24" },
    { revenue_year_key: "0000715957_2025", cik: "0000715957", report_year: 2025, revenue_usd: 11_500_000_000, accession_number: "SAMPLE-25" },
  ],
  utility_state_year: [
    { report_year: 2023, state: "VA", generator_count: 100, net_generation_mwh: 50_000_000, installed_capacity_mw: 20_000 },
    { report_year: 2024, state: "VA", generator_count: 104, net_generation_mwh: 51_000_000, installed_capacity_mw: 20_600 },
    { report_year: 2025, state: "VA", generator_count: 110, net_generation_mwh: 52_500_000, installed_capacity_mw: 21_400 },
  ],
  weather_period: [
    { weather_period_key: "VA_2025_JANFEB", state: "VA", station_id: "USW00013740", observed_days: 37, mean_daily_tmax_c: 8.1, mean_daily_tmin_c: -1.9 },
  ],
};

export async function runOffline(sql: string): Promise<QueryRun> {
  const base = { id: queryId(sql), sql: sql.trim(), at: new Date().toISOString(), ms: 1 };
  const table = Object.keys(SAMPLE).find((t) => new RegExp(`\\.${t}\\b`, "i").test(sql));
  if (!table) return { ...base, ok: false, columns: [], rows: [], error: "offline: no catalog table in query" };
  const rows = SAMPLE[table];
  return { ...base, ok: true, rows, columns: Object.keys(rows[0]) };
}
