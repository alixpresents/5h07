import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

export const HAIKU = "claude-haiku-4-5-20251001";
export const SONNET = "claude-sonnet-4-20250514";
export const OPUS = "claude-opus-4-5-20251101";

// Keep MODEL as default for any remaining callers
export const MODEL = HAIKU;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Per-model pricing ($/Mtok)
const PRICING: Record<string, { input: number; output: number }> = {
  [HAIKU]:  { input: 0.80, output: 4.00 },
  [SONNET]: { input: 3.00, output: 15.00 },
  [OPUS]:   { input: 15.00, output: 75.00 },
};

// Per-model token tracking
const usageByModel: Record<string, { input: number; output: number; calls: number }> = {};

export function getTokenUsage(): { byModel: Record<string, { input: number; output: number; calls: number; cost: string }>; totalCost: string } {
  const byModel: Record<string, { input: number; output: number; calls: number; cost: string }> = {};
  let totalCost = 0;
  for (const [model, usage] of Object.entries(usageByModel)) {
    const pricing = PRICING[model] ?? { input: 1, output: 5 };
    const cost = (usage.input * pricing.input + usage.output * pricing.output) / 1_000_000;
    totalCost += cost;
    const shortName = model.includes("haiku") ? "haiku" : model.includes("sonnet") ? "sonnet" : model.includes("opus") ? "opus" : model;
    byModel[shortName] = { input: usage.input, output: usage.output, calls: usage.calls, cost: `$${cost.toFixed(4)}` };
  }
  return { byModel, totalCost: `$${totalCost.toFixed(4)}` };
}

export function resetTokenUsage(): void {
  for (const k of Object.keys(usageByModel)) delete usageByModel[k];
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
      const model = params.model;
      if (!usageByModel[model]) usageByModel[model] = { input: 0, output: 0, calls: 0 };
      usageByModel[model].input += input;
      usageByModel[model].output += output;
      usageByModel[model].calls++;
      const shortModel = model.includes("haiku") ? "haiku" : model.includes("sonnet") ? "sonnet" : model.includes("opus") ? "opus" : model;
      console.log(`[${new Date().toISOString()}] [llm:${shortModel}] ${label}: ${input} in / ${output} out tokens`);
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
