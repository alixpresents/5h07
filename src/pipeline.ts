import Anthropic from "@anthropic-ai/sdk";
import { scrape } from "./scraper.js";
import { dedup } from "./dedup.js";
import { score } from "./scorer.js";
import type { ScoredCluster } from "./scorer.js";
import { summarize } from "./summarizer.js";
import { generate } from "./generator.js";
import { config } from "./config.js";
import { supabase } from "./db.js";
import { llmCall, HAIKU, getTokenUsage } from "./llm.js";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [pipeline] ${msg}`);
}

async function runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  log(`--- ${name} ---`);
  const start = Date.now();
  const result = await fn();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`--- ${name} done in ${elapsed}s ---\n`);
  return result;
}

interface SerializedCluster {
  name: string;
  article_ids: string[];
  source_names: string[];
  orientations: string[];
  raw_orientations: string[];
  best_title: string;
  best_description: string | null;
  best_article_id: string;
  score_couverture: number;
  score_diversite: number;
  score_llm: number;
  score_fraicheur: number;
  score_final: number;
  num_sources: number;
  is_new?: boolean;
  streak_days?: number;
}

function serializeClusters(clusters: ScoredCluster[]): SerializedCluster[] {
  return clusters.map((c) => ({
    name: c.name,
    article_ids: c.article_ids,
    source_names: c.source_names,
    orientations: [...c.orientations],
    raw_orientations: c.raw_orientations,
    best_title: c.best_title,
    best_description: c.best_description,
    best_article_id: c.best_article_id,
    score_couverture: c.score_couverture,
    score_diversite: c.score_diversite,
    score_llm: c.score_llm,
    score_fraicheur: c.score_fraicheur,
    score_final: c.score_final,
    num_sources: c.sources.length,
  }));
}

async function fetchPastClusters(days: number): Promise<Record<string, string[]>> {
  // Returns { "2026-03-22": ["sujet1", "sujet2", ...], ... }
  const result: Record<string, string[]> = {};
  const { data, error } = await supabase
    .from("daily_digests")
    .select("date, article_ids")
    .order("date", { ascending: false })
    .limit(days);

  if (error || !data) return result;
  for (const row of data) {
    const clusters = (row.article_ids as { clusters?: { name: string }[] })?.clusters;
    if (clusters) {
      result[row.date as string] = clusters.map((c) => c.name);
    }
  }
  return result;
}

async function enrichWithHistory(
  topClusters: SerializedCluster[],
  dateIso: string
): Promise<SerializedCluster[]> {
  const pastData = await fetchPastClusters(30);
  const pastDates = Object.keys(pastData).filter((d) => d !== dateIso).sort().reverse();

  if (pastDates.length === 0) {
    log("No past data, skipping history enrichment");
    return topClusters;
  }

  // Collect all past cluster names
  const allPastNames: string[] = [];
  for (const d of pastDates) {
    for (const name of pastData[d]) {
      if (!allPastNames.includes(name)) allPastNames.push(name);
    }
  }

  const todayNames = topClusters.map((c) => c.name);

  // Ask Haiku to match today's subjects with past subjects
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await llmCall(client, {
    model: HAIKU,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `voici les sujets d'aujourd'hui :
${todayNames.map((n, i) => `${i}: ${n}`).join("\n")}

voici les sujets des jours précédents :
${allPastNames.map((n, i) => `${i}: ${n}`).join("\n")}

pour chaque sujet d'aujourd'hui, dis-moi s'il correspond à un sujet des jours précédents (même événement, même thème continu). réponds UNIQUEMENT en JSON brut (pas de markdown). un objet où chaque clé est le nom exact du sujet d'aujourd'hui et la valeur est le nom exact du sujet passé correspondant, ou null si c'est un sujet nouveau.`,
      },
    ],
  }, "history");

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  let matches: Record<string, string | null> = {};
  if (jsonMatch) {
    try {
      matches = JSON.parse(jsonMatch[0]);
    } catch {
      log("Failed to parse history matches");
    }
  }

  // Compute streak and is_new for each cluster
  for (const cluster of topClusters) {
    const matchedPastName = matches[cluster.name];

    if (!matchedPastName) {
      // New subject
      cluster.is_new = cluster.num_sources >= 5;
      cluster.streak_days = 1;
    } else {
      // Find consecutive days this subject appeared
      cluster.is_new = false;
      let streak = 1;
      for (const d of pastDates) {
        const dayNames = pastData[d];
        if (dayNames.includes(matchedPastName)) {
          streak++;
        } else {
          break; // Streak broken
        }
      }
      cluster.streak_days = streak;
    }
  }

  // Log results
  for (const c of topClusters.slice(0, 10)) {
    const tags = [];
    if (c.is_new) tags.push("🔺 nouveau");
    if (c.streak_days && c.streak_days > 1) tags.push(`jour ${c.streak_days}`);
    if (tags.length > 0) log(`  ${c.name} — ${tags.join(", ")}`);
  }

  return topClusters;
}

async function main(): Promise<void> {
  const skipScraper = process.argv.includes("--skip-scraper");
  log("=== 5h07 pipeline start ===\n");
  const start = Date.now();

  // 1. Scrape all RSS sources
  if (skipScraper) {
    log("--- 1. scraper SKIPPED (--skip-scraper) ---\n");
  } else {
    await runStep("1. scraper", scrape);
  }

  // 2. Cluster ALL articles by event (dedup)
  const clusters = await runStep("2. dedup", dedup);

  // 3. Multi-signal scoring (coverage + diversity + LLM + freshness)
  const scored = await runStep("3. scorer", () => score(clusters));

  // 4. Enrich with history (streak, is_new)
  const dateIso = new Date().toISOString().slice(0, 10);
  let topClusters = serializeClusters(scored.filter((c) => c.score_final > 0).slice(0, 30));
  topClusters = await runStep("4. history", () => enrichWithHistory(topClusters, dateIso));

  // Save to daily_digests
  await supabase
    .from("daily_digests")
    .upsert({
      date: dateIso,
      article_ids: { clusters: topClusters },
    }, { onConflict: "date" });
  log(`Saved ${topClusters.length} scored clusters to daily_digests`);

  // 5. Summarize top articles + generate recaps
  // Pass top cluster names so the recap covers exactly the same subjects as "pourquoi ces sujets"
  const topClusterNames = topClusters
    .filter((c) => c.score_final >= 4)
    .slice(0, 7)
    .map((c) => c.name);
  await runStep("5. summarizer", () => summarize(10, topClusterNames));

  // 6. Generate static HTML site
  await runStep("6. generator", generate);

  const total = ((Date.now() - start) / 1000).toFixed(1);
  const usage = getTokenUsage();
  log(`=== pipeline complete in ${total}s ===`);
  log(`=== LLM cost breakdown ===`);
  for (const [model, stats] of Object.entries(usage.byModel)) {
    log(`  ${model}: ${stats.calls} calls, ${stats.input} in / ${stats.output} out, ${stats.cost}`);
  }
  log(`  TOTAL: ${usage.totalCost}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
