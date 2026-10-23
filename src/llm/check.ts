// Confirms the NVIDIA key works, lists the Nemotron models it can reach,
// and checks that the configured model answers.
import "../env.ts";
import { requireEnv } from "../env.ts";
import { chat, model } from "./nemotron.ts";

const base = (process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${requireEnv("NVIDIA_API_KEY")}` } });
if (res.ok) {
  const { data } = (await res.json()) as { data: { id: string }[] };
  const nemotron = data.map((m) => m.id).filter((id) => id.includes("nemotron")).sort();
  console.log(`Nemotron models available (${nemotron.length}):\n  ${nemotron.join("\n  ")}`);
} else {
  console.log(`Could not list models: HTTP ${res.status}`);
}

const reply = await chat([{ role: "user", content: "Reply with exactly: receipts online" }], { maxTokens: 64 });
console.log(`\n${model()}: ${reply}`);
