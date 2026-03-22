import { scrape } from "./scraper.js";
import { dedup } from "./dedup.js";
import { score } from "./scorer.js";
import type { ScoredCluster } from "./scorer.js";
import { summarize } from "./summarizer.js";
import { generate } from "./generator.js";
import { supabase } from "./db.js";

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

// Serialize ScoredCluster for JSON storage (Sets → arrays)
function serializeClusters(clusters: ScoredCluster[]): object[] {
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

async function main(): Promise<void> {
  log("=== 5h07 pipeline start ===\n");
  const start = Date.now();

  // 1. Scrape all RSS sources
  await runStep("1. scraper", scrape);

  // 2. Cluster ALL articles by event (dedup)
  const clusters = await runStep("2. dedup", dedup);

  // 3. Multi-signal scoring (coverage + diversity + LLM + freshness)
  const scored = await runStep("3. scorer", () => score(clusters));

  // Save top clusters to daily_digests for generator
  const dateIso = new Date().toISOString().slice(0, 10);
  const topClusters = serializeClusters(scored.filter((c) => c.score_final > 0).slice(0, 30));
  await supabase
    .from("daily_digests")
    .upsert({
      date: dateIso,
      article_ids: { clusters: topClusters },
    }, { onConflict: "date" });
  log(`Saved ${topClusters.length} scored clusters to daily_digests`);

  // 4. Summarize top articles + generate recaps
  await runStep("4. summarizer", summarize);

  // 5. Generate static HTML site
  await runStep("5. generator", generate);

  const total = ((Date.now() - start) / 1000).toFixed(1);
  log(`=== pipeline complete in ${total}s ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
