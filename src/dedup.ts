import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { supabase } from "./db.js";

const MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 100;

interface RawArticle {
  id: string;
  title: string;
  source_id: string;
  published_at: string | null;
  description: string | null;
}

export interface ClusterInfo {
  name: string;
  article_ids: string[];
  sources: string[]; // source_ids (deduplicated)
  orientations: Set<string>; // for scoring diversity (gauche/centre/droite only)
  raw_orientations: string[]; // all raw orientations for blind spots
  source_names: string[];
  earliest: Date | null;
  latest: Date | null;
  best_title: string;
  best_description: string | null;
  best_article_id: string;
}

interface SourceInfo {
  id: string;
  name: string;
  orientation: string;
  category: string;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [dedup] ${msg}`);
}

async function fetchAllArticles(): Promise<RawArticle[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("id, title, source_id, published_at, description")
    .order("published_at", { ascending: false });

  if (error) throw new Error(`Failed to fetch articles: ${error.message}`);
  return data ?? [];
}

async function fetchSources(): Promise<Map<string, SourceInfo>> {
  const { data, error } = await supabase
    .from("sources")
    .select("id, name, orientation, category")
    .eq("active", true);

  if (error) throw new Error(`Failed to fetch sources: ${error.message}`);
  const map = new Map<string, SourceInfo>();
  for (const s of data ?? []) {
    map.set(s.id, { id: s.id, name: s.name, orientation: s.orientation ?? "centre", category: s.category ?? "" });
  }
  return map;
}

// For scoring diversity: only gauche/centre/droite matter.
// Service public, spécialisé, régionale are excluded.
export function normalizePolitical(o: string): string | null {
  o = o.toLowerCase();
  if (o === "service public" || o === "specialise" || o === "regionale") return null;
  if (o.includes("gauche")) return "gauche";
  if (o.includes("droite")) return "droite";
  return "centre";
}

async function clusterBatch(
  client: Anthropic,
  articles: RawArticle[]
): Promise<Record<string, string[]>> {
  const articlesText = articles
    .map((a) => `- ID: ${a.id} | ${a.title}`)
    .join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    messages: [
      {
        role: "user",
        content: `Tu es un éditeur de journal. Voici une liste d'articles. Regroupe-les par événement : les articles qui couvrent le même fait d'actualité doivent être dans le même groupe.

Donne à chaque groupe un nom court décrivant l'événement (ex: "Réforme des retraites", "Fermeture du détroit d'Ormuz", "Second tour des municipales 2026").

RÈGLE IMPORTANTE : ne crée jamais de cluster générique. Chaque cluster doit correspondre à UN événement précis et identifiable. Si un article ne rentre dans aucun événement précis, laisse-le seul dans son propre cluster. Des noms comme "société", "politique", "violences", "divers", "sport", "économie", "politique internationale", "société et vie quotidienne" sont INTERDITS.

Réponds UNIQUEMENT en JSON brut (pas de markdown, pas de \`\`\`). Un objet où chaque clé est le nom de l'événement et chaque valeur est un tableau d'IDs d'articles.

Articles :

${articlesText}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log(`Warning: no JSON in clusterBatch response, putting each article in its own cluster`);
    const fallback: Record<string, string[]> = {};
    for (const a of articles) fallback[a.title.slice(0, 60)] = [a.id];
    return fallback;
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    log(`Warning: bad JSON in clusterBatch, putting each article in its own cluster`);
    const fallback: Record<string, string[]> = {};
    for (const a of articles) fallback[a.title.slice(0, 60)] = [a.id];
    return fallback;
  }
}

// Pass 2: merge clusters that cover the same subject
async function mergeClusters(
  client: Anthropic,
  clusterNames: string[]
): Promise<{ nom_final: string; clusters_inclus: string[] }[]> {
  if (clusterNames.length <= 5) {
    return clusterNames.map((n) => ({ nom_final: n, clusters_inclus: [n] }));
  }

  // If too many clusters, only merge the top ones (by name frequency/similarity)
  // and leave the rest as-is
  const MERGE_BATCH = 200;
  if (clusterNames.length > MERGE_BATCH) {
    log(`Too many clusters (${clusterNames.length}) for single merge call, batching...`);
    const results: { nom_final: string; clusters_inclus: string[] }[] = [];
    for (let i = 0; i < clusterNames.length; i += MERGE_BATCH) {
      const batch = clusterNames.slice(i, i + MERGE_BATCH);
      const batchResults = await mergeClusters(client, batch);
      results.push(...batchResults);
    }
    return results;
  }

  const namesText = clusterNames.map((n, i) => `${i}: ${n}`).join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    messages: [
      {
        role: "user",
        content: `voici une liste d'événements détectés dans la presse. certains sont en réalité le même sujet vu sous des angles différents. regroupe-les.

par exemple 'municipales 2026 lyon', 'municipales 2026 paris', 'municipales 2026 participation' et 'élections municipales en france' c'est UN seul sujet : les municipales 2026.

pareil, 'guerre iran-israël', 'guerre au moyen-orient', 'blocage du détroit d'ormuz', 'tensions iran-états-unis' c'est UN seul sujet : le conflit iran-israël.

les événements qui ne se regroupent avec rien restent seuls.

RÈGLE : le nom_final doit être un événement précis, jamais une catégorie générique. des noms comme "société", "politique", "violences", "divers", "sport", "économie", "politique internationale" sont INTERDITS. si un cluster a un nom générique, éclate-le ou renomme-le avec l'événement précis.

réponds UNIQUEMENT en JSON brut (pas de markdown). un tableau d'objets avec 'nom_final' (le nom synthétique du sujet) et 'clusters_inclus' (les noms exacts des clusters à fusionner, tels qu'ils apparaissent dans la liste).

Événements :

${namesText}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    log("Pass 2 merge failed (no JSON), skipping fusion");
    return clusterNames.map((n) => ({ nom_final: n, clusters_inclus: [n] }));
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    log(`Pass 2 merge failed (bad JSON), skipping fusion`);
    return clusterNames.map((n) => ({ nom_final: n, clusters_inclus: [n] }));
  }
}

// Pass 3: final dedup check on merged cluster names
async function finalDedupCheck(
  client: Anthropic,
  clusterNames: string[]
): Promise<{ from: string[]; to: string }[]> {
  if (clusterNames.length <= 3) return [];

  const namesText = clusterNames.join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `voici la liste finale des sujets retenus. vérifie qu'il n'y a aucun doublon. si deux sujets parlent de la même chose (ex: 'conflit iran-israël' et 'guerre moyen-orient iran israël', ou 'municipales 2026' et 'participation aux municipales 2026'), fusionne-les sous un seul nom.

réponds UNIQUEMENT en JSON brut (pas de markdown). un tableau d'objets avec 'from' (tableau des noms à fusionner) et 'to' (le nom final). si rien à fusionner, réponds [].

Sujets :

${namesText}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }
}

async function updateClusters(
  clusters: Record<string, string[]>
): Promise<void> {
  for (const [clusterName, ids] of Object.entries(clusters)) {
    for (const id of ids) {
      const { error } = await supabase
        .from("articles")
        .update({ cluster_id: clusterName })
        .eq("id", id);

      if (error && !error.message.includes("invalid input syntax")) {
        log(`Failed to update cluster for ${id}: ${error.message}`);
      }
    }
  }
}

function buildClusterInfo(
  name: string,
  articleIds: string[],
  articleMap: Map<string, RawArticle>,
  sourceMap: Map<string, SourceInfo>
): ClusterInfo | null {
  const validArticles = articleIds
    .map((id) => articleMap.get(id))
    .filter((a): a is RawArticle => a !== undefined);

  if (validArticles.length === 0) return null;

  const sourceIds = [...new Set(validArticles.map((a) => a.source_id))];
  const orientations = new Set<string>();
  const rawOrientations: string[] = [];
  const sourceNames: string[] = [];

  for (const sid of sourceIds) {
    const src = sourceMap.get(sid);
    if (src) {
      sourceNames.push(src.name);
      rawOrientations.push(src.orientation);
      const pol = normalizePolitical(src.orientation);
      if (pol) orientations.add(pol);
    }
  }

  const timestamps = validArticles
    .filter((a) => a.published_at)
    .map((a) => new Date(a.published_at!))
    .sort((a, b) => a.getTime() - b.getTime());

  const sorted = [...validArticles].sort(
    (a, b) => (b.description?.length ?? 0) - (a.description?.length ?? 0)
  );
  const best = sorted[0];

  return {
    name,
    article_ids: articleIds,
    sources: sourceIds,
    orientations,
    raw_orientations: rawOrientations,
    source_names: sourceNames,
    earliest: timestamps[0] ?? null,
    latest: timestamps[timestamps.length - 1] ?? null,
    best_title: best.title,
    best_description: best.description,
    best_article_id: best.id,
  };
}

export async function dedup(): Promise<ClusterInfo[]> {
  log("Starting deduplication on ALL articles...");

  const [articles, sourceMap] = await Promise.all([
    fetchAllArticles(),
    fetchSources(),
  ]);
  log(`Found ${articles.length} articles, ${sourceMap.size} sources`);

  if (articles.length === 0) {
    log("Nothing to deduplicate.");
    return [];
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const articleMap = new Map(articles.map((a) => [a.id, a]));

  // === PASS 1: cluster articles by title similarity ===
  let allClusters: Record<string, string[]> = {};
  const batches = Math.ceil(articles.length / BATCH_SIZE);

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    log(`Pass 1 — clustering batch ${batchNum}/${batches} (${batch.length} articles)...`);

    const clusters = await clusterBatch(client, batch);
    for (const [name, ids] of Object.entries(clusters)) {
      if (allClusters[name]) {
        allClusters[name].push(...ids);
      } else {
        allClusters[name] = ids;
      }
    }
  }

  log(`Pass 1 done: ${Object.keys(allClusters).length} clusters`);

  // === PASS 2: merge clusters that are the same subject ===
  const clusterNames = Object.keys(allClusters);
  log(`Pass 2 — merging ${clusterNames.length} cluster names...`);
  const mergeGroups = await mergeClusters(client, clusterNames);

  // Build merged clusters
  const mergedClusters: Record<string, string[]> = {};
  const usedNames = new Set<string>();

  for (const group of mergeGroups) {
    const allIds: string[] = [];
    for (const oldName of group.clusters_inclus) {
      if (allClusters[oldName]) {
        allIds.push(...allClusters[oldName]);
        usedNames.add(oldName);
      }
    }
    if (allIds.length > 0) {
      if (mergedClusters[group.nom_final]) {
        mergedClusters[group.nom_final].push(...allIds);
      } else {
        mergedClusters[group.nom_final] = allIds;
      }
    }
  }

  // Add any clusters that weren't included in any merge group
  for (const [name, ids] of Object.entries(allClusters)) {
    if (!usedNames.has(name) && !mergedClusters[name]) {
      mergedClusters[name] = ids;
    }
  }

  log(`Pass 2 done: ${Object.keys(allClusters).length} → ${Object.keys(mergedClusters).length} clusters after fusion`);

  // === PASS 3: final dedup check on merged names ===
  const mergedNames = Object.keys(mergedClusters);
  log(`Pass 3 — final dedup check on ${mergedNames.length} cluster names...`);
  const finalFusions = await finalDedupCheck(client, mergedNames);

  let pass3Count = 0;
  for (const fusion of finalFusions) {
    if (!fusion.from || fusion.from.length < 2) continue;
    const targetIds: string[] = mergedClusters[fusion.to] ?? [];
    for (const fromName of fusion.from) {
      if (fromName === fusion.to) continue;
      if (mergedClusters[fromName]) {
        targetIds.push(...mergedClusters[fromName]);
        delete mergedClusters[fromName];
        pass3Count++;
      }
    }
    mergedClusters[fusion.to] = targetIds;
  }
  log(`Pass 3 done: ${pass3Count} additional fusions`);

  await updateClusters(mergedClusters);

  // Build ClusterInfo
  const clusterInfos: ClusterInfo[] = [];
  for (const [name, ids] of Object.entries(mergedClusters)) {
    const info = buildClusterInfo(name, ids, articleMap, sourceMap);
    if (info) clusterInfos.push(info);
  }

  log(`--- Top clusters ---`);
  const sorted = [...clusterInfos].sort((a, b) => b.sources.length - a.sources.length);
  for (const c of sorted.slice(0, 15)) {
    log(`• ${c.name} (${c.article_ids.length} articles, ${c.source_names.length} sources)`);
  }
  log(`${clusterInfos.length} events total from ${articles.length} articles`);

  return clusterInfos;
}

// Run directly
if (require.main === module) {
  dedup().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
