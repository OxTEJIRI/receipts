// Loads the data Receipts investigates into Zetaris: SEC EDGAR revenue facts
// (REST), PUDL generator data (public S3 Parquet) and NOAA GHCN-Daily weather
// (public S3 CSV), linked by a USL model. Based on the zetaris/getting-started
// EDGAR + PUDL + NOAA guide, extended to per-year weather for 2022-2025 so
// weather can be compared across the same years as revenue.
//
//   npm run zetaris:setup            -> dry run, prints the plan
//   npm run zetaris:setup -- --apply -> runs it, one statement per call
import "../env.ts";
import { runQuery } from "./client.ts";
import { NS } from "../agent/catalog.ts";

const UA = process.env.ZETARIS_USER_AGENT;
const S3_PUDL = `isS3BucketPublic "true", useS3PathStyleAccess "true", s3Endpoint "s3.us-west-2.amazonaws.com"`;
const S3_NOAA = `isS3BucketPublic "true", useS3PathStyleAccess "true", s3Endpoint "s3.us-east-1.amazonaws.com"`;
const STATIONS = [
  { state: "VA", id: "USW00013740", name: "RICHMOND INTL AP", table: "noaa_va_airport" },
  { state: "NC", id: "USW00013722", name: "RALEIGH AP", table: "noaa_nc_airport" },
  { state: "SC", id: "USW00013880", name: "CHARLESTON INTL AP", table: "noaa_sc_airport" },
];
const NS_ROOT = NS.split(".").slice(0, 3).join(".");
const USL = NS.split(".").pop()!;

interface Step {
  name: string;
  sql: string;
  okIf?: RegExp; // error text that means "already done"
  optional?: boolean; // a speed-up only; carry on if it fails
}

const EXISTS = /already exists|AlreadyExists|duplicate/i;

export function steps(): Step[] {
  if (!UA) throw new Error('Set ZETARIS_USER_AGENT in .env.local, e.g. "Receipts you@example.com" (SEC requires a contact).');
  return [
    // A fresh local install has no lightning.metastore parent yet.
    { name: "parent namespace", sql: `CREATE NAMESPACE IF NOT EXISTS ${NS_ROOT.split(".").slice(0, 2).join(".")}` },
    { name: "namespace", sql: `CREATE NAMESPACE IF NOT EXISTS ${NS_ROOT}` },

    { name: "SEC database", sql: `CREATE LIGHTNING DATABASE SEC_DATA DESCRIBE BY "SEC EDGAR company facts REST source"`, okIf: EXISTS },
    {
      name: "SEC revenue facts (Dominion Energy)",
      okIf: EXISTS,
      sql: `CREATE LIGHTNING REST TABLE dominion_revenue_facts FROM SEC_DATA REQUEST(
    endpoint "https://data.sec.gov/api/xbrl/companyconcept/CIK0000715957/us-gaap/Revenues.json",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
    user-agent "${UA}"
) BODY ()`,
    },

    { name: "PUDL database", sql: `CREATE LIGHTNING DATABASE PUDL_S3 DESCRIBE BY "Catalyst Cooperative PUDL S3 filestore source"`, okIf: EXISTS },
    {
      name: "PUDL SEC-to-EIA utility matches",
      okIf: EXISTS,
      sql: `CREATE LIGHTNING FILESTORE TABLE pudl_sec10k_utility_matches FROM PUDL_S3 FORMAT PARQUET OPTIONS (
  PATH "s3a://pudl.catalyst.coop/stable/core_sec10k__assn_sec10k_filers_and_eia_utilities.parquet",
  inferSchema "true", ${S3_PUDL}
)`,
    },
    {
      name: "PUDL yearly generators",
      okIf: EXISTS,
      sql: `CREATE LIGHTNING FILESTORE TABLE pudl_eia_yearly_generators FROM PUDL_S3 FORMAT PARQUET OPTIONS (
  PATH "s3a://pudl.catalyst.coop/stable/out_eia__yearly_generators.parquet",
  inferSchema "true", ${S3_PUDL}
)`,
    },

    { name: "NOAA database", sql: `CREATE LIGHTNING DATABASE NOAA_GHCN_S3 DESCRIBE BY "NOAA GHCN-Daily S3 filestore source"`, okIf: EXISTS },
    ...STATIONS.map((s) => ({
      name: `NOAA station ${s.state} (${s.name})`,
      okIf: EXISTS,
      sql: `CREATE LIGHTNING FILESTORE TABLE ${s.table} FROM NOAA_GHCN_S3 FORMAT CSV OPTIONS (
  PATH "s3a://noaa-ghcn-pds/csv/by_station/${s.id}.csv",
  inferSchema "false", header "false", ${S3_NOAA}
)`,
    })),
    ...STATIONS.map((s) => ({ name: `cache NOAA ${s.state}`, sql: `CACHE TABLE NOAA_GHCN_S3.${s.table}`, optional: true })),

    {
      name: "compile USL model",
      okIf: EXISTS,
      sql: `COMPILE USL IF NOT EXISTS ${USL} DEPLOY NAMESPACE ${NS_ROOT} DDL
CREATE TABLE company (
  cik          varchar(10) NOT NULL PRIMARY KEY,
  company_name varchar(200) NOT NULL
);

CREATE TABLE revenue_year (
  revenue_year_key varchar(20) NOT NULL PRIMARY KEY,
  cik              varchar(10) NOT NULL FOREIGN KEY REFERENCES company(cik),
  report_year      integer NOT NULL,
  period_start     date,
  period_end       date,
  revenue_usd      double,
  filing_date      date,
  accession_number varchar(30)
);

CREATE TABLE weather_period (
  weather_period_key      varchar(40) NOT NULL PRIMARY KEY,
  state                   varchar(2) NOT NULL,
  station_id              varchar(11) NOT NULL,
  station_name            varchar(60),
  period_start            date,
  period_end              date,
  observed_days           integer,
  valid_measurement_count integer,
  mean_daily_tmax_c       double,
  mean_daily_tmin_c       double,
  mean_daily_precip_mm    double
);

CREATE TABLE utility_state_year (
  utility_state_year_key varchar(40) NOT NULL PRIMARY KEY,
  cik                   varchar(10) NOT NULL FOREIGN KEY REFERENCES company(cik),
  revenue_year_key      varchar(20) FOREIGN KEY REFERENCES revenue_year(revenue_year_key),
  weather_period_key    varchar(40) FOREIGN KEY REFERENCES weather_period(weather_period_key),
  utility_id_eia        bigint NOT NULL,
  report_year           integer NOT NULL,
  state                 varchar(2) NOT NULL,
  generator_count       integer,
  net_generation_mwh    double,
  installed_capacity_mw double
);`,
    },

    {
      name: "activate company",
      sql: `ACTIVATE USL TABLE ${NS}.company AS
SELECT COALESCE(LPAD(CAST(cik AS STRING), 10, '0'), '') AS cik, COALESCE(MAX(entityName), '') AS company_name
FROM SEC_DATA.dominion_revenue_facts GROUP BY cik`,
    },
    {
      name: "activate revenue_year",
      sql: `ACTIVATE USL TABLE ${NS}.revenue_year AS
SELECT COALESCE(CONCAT(cik, '_', CAST(report_year AS STRING)), '') AS revenue_year_key, COALESCE(cik, '') AS cik,
       COALESCE(report_year, 0) AS report_year, period_start, period_end, revenue_usd, filing_date, accession_number
FROM (
  SELECT LPAD(CAST(cik AS STRING), 10, '0') AS cik, YEAR(CAST(fact.\`end\` AS DATE)) AS report_year,
         CAST(fact.start AS DATE) AS period_start, CAST(fact.\`end\` AS DATE) AS period_end,
         CAST(fact.val AS DOUBLE) AS revenue_usd, CAST(fact.filed AS DATE) AS filing_date, fact.accn AS accession_number,
         ROW_NUMBER() OVER (PARTITION BY fact.\`end\` ORDER BY fact.filed DESC, fact.accn DESC) AS rn
  FROM SEC_DATA.dominion_revenue_facts LATERAL VIEW explode(units.USD) AS fact
  WHERE fact.form = '10-K' AND fact.fp = 'FY'
    AND DATEDIFF(CAST(fact.\`end\` AS DATE), CAST(fact.start AS DATE)) BETWEEN 330 AND 400
    AND YEAR(CAST(fact.\`end\` AS DATE)) BETWEEN 2020 AND 2025
) annual_facts WHERE rn = 1`,
    },
    {
      name: "activate weather_period (per state and year)",
      sql: `ACTIVATE USL TABLE ${NS}.weather_period AS
SELECT COALESCE(CONCAT(state, '_', SUBSTR(obs_date, 1, 4)), '') AS weather_period_key, COALESCE(state, '') AS state,
       COALESCE(station_id, '') AS station_id, COALESCE(station_name, '') AS station_name,
       CAST(CONCAT(SUBSTR(MIN(obs_date),1,4),'-',SUBSTR(MIN(obs_date),5,2),'-',SUBSTR(MIN(obs_date),7,2)) AS DATE) AS period_start,
       CAST(CONCAT(SUBSTR(MAX(obs_date),1,4),'-',SUBSTR(MAX(obs_date),5,2),'-',SUBSTR(MAX(obs_date),7,2)) AS DATE) AS period_end,
       CAST(COUNT(DISTINCT obs_date) AS INT) AS observed_days, CAST(COUNT(*) AS INT) AS valid_measurement_count,
       AVG(CASE WHEN element='TMAX' THEN CAST(data_value AS DOUBLE)/10.0 END) AS mean_daily_tmax_c,
       AVG(CASE WHEN element='TMIN' THEN CAST(data_value AS DOUBLE)/10.0 END) AS mean_daily_tmin_c,
       AVG(CASE WHEN element='PRCP' THEN CAST(data_value AS DOUBLE)/10.0 END) AS mean_daily_precip_mm
FROM (
${STATIONS.map((s) => `  SELECT '${s.state}' AS state, '${s.id}' AS station_id, '${s.name}' AS station_name, _c1 AS obs_date, _c2 AS element, _c3 AS data_value FROM NOAA_GHCN_S3.${s.table}`).join("\n  UNION ALL\n")}
) obs
WHERE obs_date BETWEEN '20220101' AND '20251231' AND element IN ('TMAX','TMIN','PRCP') AND CAST(data_value AS INT) <> -9999
GROUP BY state, station_id, station_name, SUBSTR(obs_date, 1, 4)`,
    },
    {
      name: "activate utility_state_year",
      sql: `ACTIVATE USL TABLE ${NS}.utility_state_year AS
SELECT COALESCE(CONCAT(m.central_index_key, '_', CAST(YEAR(g.report_date) AS STRING), '_', g.state), '') AS utility_state_year_key,
       COALESCE(m.central_index_key, '') AS cik,
       COALESCE(CONCAT(m.central_index_key, '_', CAST(YEAR(g.report_date) AS STRING)), '') AS revenue_year_key,
       CONCAT(g.state, '_', CAST(YEAR(g.report_date) AS STRING)) AS weather_period_key,
       COALESCE(m.utility_id_eia, 0) AS utility_id_eia, COALESCE(YEAR(g.report_date), 0) AS report_year,
       COALESCE(g.state, '') AS state, CAST(COUNT(*) AS INT) AS generator_count,
       SUM(g.net_generation_mwh) AS net_generation_mwh, SUM(g.capacity_mw) AS installed_capacity_mw
FROM PUDL_S3.pudl_sec10k_utility_matches m
JOIN PUDL_S3.pudl_eia_yearly_generators g ON m.utility_id_eia = g.utility_id_eia
WHERE m.central_index_key = '0000715957' AND g.report_date BETWEEN DATE '2020-01-01' AND DATE '2025-12-31'
GROUP BY m.central_index_key, m.utility_id_eia, YEAR(g.report_date), g.state`,
    },
  ];
}

// Caching the model cuts live queries from ~30-50 s to ~2 s on a laptop, and
// means an investigation doesn't depend on SEC answering at that moment.
export function cacheSteps(): Step[] {
  return ["SEC_DATA.dominion_revenue_facts", ...["company", "revenue_year", "utility_state_year", "weather_period"].map((t) => `${NS}.${t}`)]
    .map((t) => ({ name: `cache ${t.split(".").pop()}`, sql: `CACHE TABLE ${t}`, optional: true }));
}

// Read-only checks that the model answers, run after setup.
export const VERIFY = [
  `SELECT report_year, revenue_usd, accession_number FROM ${NS}.revenue_year ORDER BY report_year`,
  `SELECT report_year, state, generator_count, net_generation_mwh, installed_capacity_mw FROM ${NS}.utility_state_year ORDER BY report_year, state`,
  `SELECT weather_period_key, observed_days, mean_daily_tmax_c, mean_daily_tmin_c FROM ${NS}.weather_period ORDER BY weather_period_key`,
];

if (process.argv[1]?.endsWith("setup.ts")) {
  const apply = process.argv.includes("--apply");
  const from = Number(process.argv[process.argv.indexOf("--from") + 1] || 1);
  const plan = [...steps(), ...cacheSteps()];
  if (!apply) {
    console.log("Dry run. Re-run with --apply to execute.\n");
    plan.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.name}`));
    process.exit(0);
  }
  for (const [i, s] of plan.entries()) {
    if (i + 1 < from) continue;
    // Caching and activation scan whole S3 files; give them up to 15 minutes.
    const r = await runQuery(s.sql, { timeoutMs: 15 * 60_000 });
    const done = r.ok || (s.okIf && r.error && s.okIf.test(r.error));
    console.log(`${done ? "OK  " : "FAIL"} ${String(i + 1).padStart(2)}. ${s.name} (${(r.ms / 1000).toFixed(1)} s)${r.ok ? "" : done ? " already exists" : `\n      ${r.error}`}`);
    if (!done && s.optional) {
      console.log("      optional step, continuing");
      continue;
    }
    if (!done) {
      console.log(`\nStopped. Fix the error above, then resume with: npm run zetaris:setup -- --apply --from ${i + 1}`);
      process.exit(1);
    }
  }
  console.log("\nVerifying:");
  for (const sql of VERIFY) {
    const r = await runQuery(sql);
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.rows.length} rows  ${sql.slice(0, 90)}...`);
    if (r.ok) console.log(r.rows.slice(0, 12).map((row) => "      " + JSON.stringify(row)).join("\n"));
    else console.log(`      ${r.error}`);
  }
}
