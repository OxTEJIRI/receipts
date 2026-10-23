// Loads .env.local (then .env) into process.env without overriding values
// already set in the shell. Keeps secrets out of source and prompts.
import fs from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined && value !== "") process.env[m[1]] = value;
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} in .env.local (see .env.example).`);
  return v;
}
