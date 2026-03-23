import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { supabase } from "./db.js";
import { llmCall, MODEL } from "./llm.js";
import type { ClusterInfo } from "./dedup.js";

const BATCH_SIZE = 30;

const SCORING_PROMPT = `Tu es un éditeur de journal. Pour chaque événement ci-dessous (titre + description), attribue un score de pertinence de 0 à 10 pour un lecteur vivant en France.

Critères de scoring :
- Magnitude : quelle est l'ampleur de l'événement ?
- Échelle : combien de personnes en France sont concernées ?
- Potentiel : est-ce que cet événement va provoquer d'autres événements importants ?

Règles strictes de scoring :
- sport (résultats, transferts, retraites de joueurs, classements) = maximum 3/10 sauf mort d'un athlète ou scandale majeur
- people, célébrités, polémiques médiatiques (animateurs TV, influenceurs) = maximum 2/10
- faits divers locaux sans impact systémique = maximum 4/10
- commémorations et anniversaires = maximum 4/10 sauf si actualité liée
- ces plafonds s'appliquent même si la couverture est forte. 20 sources qui parlent de biathlon, ça reste du sport.
Privilégie : politique intérieure/extérieure impactante, économie, santé publique, justice, environnement, tech/science quand l'impact est concret.

Réponds UNIQUEMENT en JSON brut (pas de markdown). Un tableau d'objets avec 'id' (le nom de l'événement) et 'score' (nombre décimal).`;

export interface ScoredCluster extends ClusterInfo {
  score_couverture: number;
  score_diversite: number;
  score_llm: number;
  score_fraicheur: number;
  score_final: number;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [scorer] ${msg}`);
}

// Signal A: coverage — how many distinct sources cover this event
function computeCoverage(cluster: ClusterInfo): number {
  return Math.min(cluster.sources.length / 8, 1) * 10;
}

// Signal B: political diversity — how many orientations cover it
function computeDiversity(cluster: ClusterInfo): number {
  return Math.min(cluster.orientations.size / 3, 1) * 10;
}

// Signal D: freshness — how fast sources picked it up
function computeFreshness(cluster: ClusterInfo): number {
  if (!cluster.earliest || !cluster.latest) return 5;
  const spreadMs = cluster.latest.getTime() - cluster.earliest.getTime();
  const spreadHours = spreadMs / (1000 * 60 * 60);
  if (spreadHours <= 3) return 10;
  if (spreadHours >= 24) return 5;
  // Linear interpolation between 3h->10 and 24h->5
  return 10 - ((spreadHours - 3) / 21) * 5;
}

async function scoreClustersLLM(
  client: Anthropic,
  clusters: ClusterInfo[]
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();

  for (let i = 0; i < clusters.length; i += BATCH_SIZE) {
    const batch = clusters.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(clusters.length / BATCH_SIZE);

    const eventsText = batch
      .map((c) => `- ID: ${c.name}\n  Titre: ${c.best_title}\n  Description: ${c.best_description ?? "(aucune)"}\n  Sources: ${c.source_names.join(", ")}`)
      .join("\n\n");

    try {
      log(`LLM scoring batch ${batchNum}/${totalBatches} (${batch.length} events)...`);
      const response = await llmCall(client, {
        model: MODEL,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: `${SCORING_PROMPT}\n\nÉvénements :\n\n${eventsText}`,
          },
        ],
      }, `scoring batch ${batchNum}`);

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        log(`✗ Batch ${batchNum}: no JSON found`);
        continue;
      }

      const results: { id: string; score: number }[] = JSON.parse(jsonMatch[0]);
      for (const r of results) {
        scores.set(r.id, r.score);
      }
      log(`✓ Batch ${batchNum} done — ${results.length} scored`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ Batch ${batchNum} FAILED — ${msg}`);
    }
  }

  return scores;
}

export async function score(clusters: ClusterInfo[]): Promise<ScoredCluster[]> {
  log("Starting multi-signal scoring...");

  // Compute free signals for all clusters
  const withFreeSignals = clusters.map((c) => ({
    ...c,
    score_couverture: computeCoverage(c),
    score_diversite: computeDiversity(c),
    score_fraicheur: computeFreshness(c),
  }));

  // Filter: only LLM-score clusters with coverage >= 4 (at least 3 sources)
  const worthScoring = withFreeSignals.filter((c) => c.score_couverture >= 4);
  log(`${clusters.length} events total, ${worthScoring.length} qualify for LLM scoring (coverage >= 4, i.e. 3+ sources)`);

  // LLM scoring on filtered clusters
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const llmScores = await scoreClustersLLM(
    client,
    worthScoring
  );

  // Compute final scores
  const scored: ScoredCluster[] = withFreeSignals.map((c) => {
    const score_llm = llmScores.get(c.name) ?? 0;
    let score_final =
      c.score_couverture * 0.35 +
      c.score_diversite * 0.25 +
      score_llm * 0.30 +
      c.score_fraicheur * 0.10;

    // Cap: if LLM says it's not important (<=3), volume can't save it
    if (score_llm <= 3) score_final = Math.min(score_final, 5.0);

    return { ...c, score_llm, score_final };
  });

  // Sort by final score
  scored.sort((a, b) => b.score_final - a.score_final);

  // Update best article score in DB for each cluster
  for (const c of scored) {
    if (c.score_final > 0) {
      const { error } = await supabase
        .from("articles")
        .update({ score: c.score_final })
        .eq("id", c.best_article_id);
      if (error) {
        log(`Failed to update score for ${c.best_article_id}: ${error.message}`);
      }
    }
  }

  // Log top 15
  log(`\n--- Top 15 events by final score ---`);
  for (const c of scored.slice(0, 15)) {
    const orientList = [...c.orientations].join("/");
    log(`\n  ${c.name}`);
    log(`    Sources (${c.source_names.length}): ${c.source_names.join(", ")}`);
    log(`    Orientations: ${orientList}`);
    log(`    Couverture: ${c.score_couverture.toFixed(1)} | Diversité: ${c.score_diversite.toFixed(1)} | LLM: ${c.score_llm.toFixed(1)} | Fraîcheur: ${c.score_fraicheur.toFixed(1)}`);
    log(`    → Score final: ${c.score_final.toFixed(2)}`);
    log(`    Article: "${c.best_title}"`);
  }

  log(`\nDone. ${scored.length} events scored.`);
  return scored;
}

// Run directly
if (require.main === module) {
  import("./dedup.js").then(({ dedup }) =>
    dedup().then((clusters) => score(clusters))
  ).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
