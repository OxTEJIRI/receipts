// What the agent is allowed to query. Mirrors the USL model from the Zetaris
// EDGAR + PUDL + NOAA guide (zetaris/getting-started), which links SEC
// revenue facts, PUDL generator data and NOAA weather through foreign keys.
// The planner only sees this catalog, so it can't invent tables.

export interface Column {
  name: string;
  type: string;
  note?: string;
}

export interface Table {
  name: string;          // fully qualified Lightning name
  source: "SEC EDGAR" | "PUDL (EIA)" | "NOAA GHCN-Daily";
  description: string;
  columns: Column[];
}

export const NS = "lightning.metastore.edgar_pudl_demo.edgar_pudl_noaa_usl";

export const CATALOG: Table[] = [
  {
    name: `${NS}.company`,
    source: "SEC EDGAR",
    description: "One row per SEC filer.",
    columns: [
      { name: "cik", type: "varchar(10)", note: "zero-padded SEC Central Index Key, primary key" },
      { name: "company_name", type: "varchar(200)" },
    ],
  },
  {
    name: `${NS}.revenue_year`,
    source: "SEC EDGAR",
    description: "Company-wide annual revenue (us-gaap:Revenues) from 10-K filings, latest filing per fiscal year.",
    columns: [
      { name: "revenue_year_key", type: "varchar(20)", note: "cik_year" },
      { name: "cik", type: "varchar(10)" },
      { name: "report_year", type: "integer" },
      { name: "period_start", type: "date" },
      { name: "period_end", type: "date" },
      { name: "revenue_usd", type: "double" },
      { name: "filing_date", type: "date" },
      { name: "accession_number", type: "varchar(30)", note: "SEC filing ID, cite it" },
    ],
  },
  {
    name: `${NS}.utility_state_year`,
    source: "PUDL (EIA)",
    description: "Generator fleet per utility, state and year from EIA-860/923 via PUDL, matched to the SEC filer.",
    columns: [
      { name: "utility_state_year_key", type: "varchar(40)" },
      { name: "cik", type: "varchar(10)" },
      { name: "revenue_year_key", type: "varchar(20)", note: "joins revenue_year" },
      { name: "weather_period_key", type: "varchar(40)", note: "joins weather_period, may be null" },
      { name: "utility_id_eia", type: "bigint" },
      { name: "report_year", type: "integer" },
      { name: "state", type: "varchar(2)" },
      { name: "generator_count", type: "integer" },
      { name: "net_generation_mwh", type: "double" },
      { name: "installed_capacity_mw", type: "double" },
    ],
  },
  {
    name: `${NS}.weather_period`,
    source: "NOAA GHCN-Daily",
    description: "Weather summary per state from one airport station per state. Coverage can be partial; check observed_days.",
    columns: [
      { name: "weather_period_key", type: "varchar(40)" },
      { name: "state", type: "varchar(2)" },
      { name: "station_id", type: "varchar(11)" },
      { name: "station_name", type: "varchar(60)" },
      { name: "period_start", type: "date" },
      { name: "period_end", type: "date" },
      { name: "observed_days", type: "integer" },
      { name: "valid_measurement_count", type: "integer" },
      { name: "mean_daily_tmax_c", type: "double" },
      { name: "mean_daily_tmin_c", type: "double" },
      { name: "mean_daily_precip_mm", type: "double" },
    ],
  },
];

// Entities loaded into the USL model, so the planner filters by CIK directly
// instead of spending a query looking it up.
export const KNOWN_CIKS: Record<string, string> = {
  "dominion energy": "0000715957",
  "sample utility co": "0000715957",
};

export function cikFor(entity: string): string | undefined {
  return KNOWN_CIKS[entity.trim().toLowerCase()];
}

export function catalogPrompt(tables: Table[] = CATALOG): string {
  return tables
    .map((t) =>
      `TABLE ${t.name}  -- source: ${t.source}. ${t.description}\n` +
      t.columns.map((c) => `  ${c.name} ${c.type}${c.note ? `  -- ${c.note}` : ""}`).join("\n"),
    )
    .join("\n\n");
}
