import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

export const MODEL = "claude-haiku-4-5-20251001";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Token tracking
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalCalls = 0;

export function getTokenUsage(): { input: number; output: number; calls: number; estimatedCost: string } {
  // Haiku 4.5: $0.80/Mtok input, $4/Mtok output
  const cost = (totalInputTokens * 0.80 + totalOutputTokens * 4) / 1_000_000;
  return {
    input: totalInputTokens,
    output: totalOutputTokens,
    calls: totalCalls,
    estimatedCost: `$${cost.toFixed(4)}`,
  };
}

export function resetTokenUsage(): void {
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCalls = 0;
}

export async function llmCall(
  client: Anthropic,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  label: string
): Promise<Anthropic.Messages.Message> {
  const delays = [10_000, 20_000, 40_000];
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await client.messages.create(params);
      const input = response.usage?.input_tokens ?? 0;
      const output = response.usage?.output_tokens ?? 0;
      totalInputTokens += input;
      totalOutputTokens += output;
      totalCalls++;
      console.log(`[${new Date().toISOString()}] [llm] ${label}: ${input} in / ${output} out tokens`);
      return response;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit =
        msg.includes("rate_limit") ||
        msg.includes("429") ||
        msg.includes("overloaded") ||
        msg.includes("Too many");

      if (isRateLimit && attempt < delays.length) {
        const wait = delays[attempt];
        console.log(`[${new Date().toISOString()}] ⏳ ${label}: rate limited, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${delays.length})...`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

export function createClient(): Anthropic {
  return new Anthropic({ apiKey: config.anthropicApiKey });
}
