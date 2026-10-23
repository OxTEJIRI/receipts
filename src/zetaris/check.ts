// Read-only connection check: SELECT 1, then list Lightning databases.
import "../env.ts";
import { runQuery } from "./client.ts";

for (const sql of ["SELECT 1", "SHOW LIGHTNING DATABASES"]) {
  const r = await runQuery(sql);
  console.log(`${r.ok ? "OK  " : "FAIL"} ${sql} (${r.ms} ms)`);
  if (r.ok) console.log(JSON.stringify(r.rows.slice(0, 20), null, 2));
  else console.log(`  ${r.error}`);
}
