// Confirms the NVIDIA key works and the configured Nemotron model answers.
import "../env.ts";
import { chat, model } from "./nemotron.ts";

const reply = await chat([{ role: "user", content: "Reply with exactly: receipts online" }], { maxTokens: 64 });
console.log(`${model()}: ${reply}`);
