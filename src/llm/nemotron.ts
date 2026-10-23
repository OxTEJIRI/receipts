// NVIDIA Nemotron through the OpenAI-compatible endpoint on build.nvidia.com.
import { requireEnv } from "../env.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean; // ask for a JSON object and parse it
}

export function model(): string {
  return process.env.NVIDIA_MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1.5";
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const base = (process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("NVIDIA_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model(),
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Nemotron call failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content ?? "";
  // Reasoning models may prefix a <think> block; callers only want the answer.
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function chatJson<T>(messages: ChatMessage[], opts: Omit<ChatOptions, "json"> = {}): Promise<T> {
  const text = await chat(messages, { ...opts, json: true });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`Nemotron did not return JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
