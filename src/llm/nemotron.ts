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
  return process.env.NVIDIA_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b";
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

export function parseJsonReply<T>(text: string): T {
  const unfenced = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
  return JSON.parse(unfenced.slice(start, end + 1)) as T;
}

// Long replies sometimes get cut off mid-object. One retry tells the model
// what went wrong and asks for a shorter, complete object.
export async function chatJson<T>(messages: ChatMessage[], opts: Omit<ChatOptions, "json"> = {}): Promise<T> {
  const text = await chat(messages, { maxTokens: 8192, ...opts, json: true });
  try {
    return parseJsonReply<T>(text);
  } catch (err) {
    const retry = await chat(
      [
        ...messages,
        { role: "assistant", content: text.slice(0, 4000) },
        { role: "user", content: `That reply was not valid JSON (${(err as Error).message.slice(0, 120)}). Reply again with one complete JSON object only. Keep it shorter: concise statements, compact SQL.` },
      ],
      { maxTokens: 8192, ...opts, json: true },
    );
    return parseJsonReply<T>(retry);
  }
}
