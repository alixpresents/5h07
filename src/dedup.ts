import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { supabase } from "./db.js";
import { llmCall, MODEL, sleep } from "./llm.js";

const LLM_BATCH_SIZE = 100;
const MAX_CONCURRENT = 2;
const DELAY_BETWEEN_BATCHES_MS = 3000;

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
  sources: string[];
  orientations: Set<string>;
  raw_orientations: string[];
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

// ─── Stopwords for keyword extraction ───────────────
const STOPWORDS = new Set([
  "le", "la", "les", "de", "du", "des", "un", "une", "et", "en", "au", "aux",
  "à", "a", "ce", "ces", "est", "son", "sa", "ses", "sur", "par", "pour",
  "dans", "avec", "qui", "que", "ne", "pas", "plus", "se", "il", "elle",
  "on", "nous", "vous", "ils", "elles", "sont", "été", "être", "avoir",
  "fait", "fait", "dit", "va", "peut", "aussi", "très", "bien", "tout",
  "cette", "entre", "après", "avant", "comme", "mais", "ou", "car",
  "direct", "live", "direct.", "d'un", "d'une", "l'", "qu'", "n'",
]);

function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function keywordOverlap(a: string[], b: string[]): number {
  let count = 0;
  const setB = new Set(b);
  for (const w of a) {
    if (setB.has(w)) count++;
  }
  return count;
}

// ─── Pre-cluster by keyword similarity (no LLM) ────
function preClusterByKeywords(articles: RawArticle[]): Map<string, RawArticle[]> {
  const groups: { keywords: string[]; articles: RawArticle[] }[] = [];

  for (const article of articles) {
    const kw = extractKeywords(article.title);
    if (kw.length === 0) {
      groups.push({ keywords: kw, articles: [article] });
      continue;
    }

    let bestGroup: typeof groups[0] | null = null;
    let bestScore = 0;

    for (const g of groups) {
      const overlap = keywordOverlap(kw, g.keywords);
      if (overlap >= 2 && overlap > bestScore) {
        bestScore = overlap;
        bestGroup = g;
      }
    }

    if (bestGroup) {
      bestGroup.articles.push(article);
      // Merge keywords
      for (const w of kw) {
        if (!bestGroup.keywords.includes(w)) bestGroup.keywords.push(w);
      }
    } else {
      groups.push({ keywords: kw, articles: [article] });
    }
  }

  const result = new Map<string, RawArticle[]>();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const label = g.articles[0].title.slice(0, 80);
    result.set(label, g.articles);
  }
  return result;
}

// ─── Concurrent LLM helper (with delay between batches) ──
async function runConcurrent<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrent: number
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrent, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── DB helpers ─────────────────────────────────────
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

export function normalizePolitical(o: string): string | null {
  o = o.toLowerCase();
  if (o === "service public" || o === "specialise" || o === "regionale" || o === "autre") return null;
  if (o.includes("gauche")) return "gauche";
  if (o.includes("droite")) return "droite";
  return "centre";
}

// ─── LLM clustering (pass 1) ────────────────────────
async function clusterBatch(
  client: Anthropic,
  articles: RawArticle[]
): Promise<Record<string, string[]>> {
  const articlesText = articles
    .map((a) => `- ID: ${a.id} | ${a.title}`)
    .join("\n");

  const response = await llmCall(client, {
    model: MODEL,
    max_tokens: 16384,
    messages: [
      {
        role: "user",
        content: `Tu es un éditeur de journal. Voici une liste d'articles pré-regroupés par thème. Affine le regroupement : sépare les articles qui parlent d'événements différents, fusionne ceux qui parlent du même événement.

Donne à chaque groupe un nom court et précis (ex: "Second tour des municipales 2026", "Fermeture du détroit d'Ormuz").

RÈGLE : ne crée jamais de cluster générique. Des noms comme "société", "politique", "sport", "économie" sont INTERDITS.

Réponds UNIQUEMENT en JSON brut (pas de markdown). Un objet où chaque clé est le nom de l'événement et chaque valeur est un tableau d'IDs d'articles.

Articles :

${articlesText}`,
      },
    ],
  }, "clusterBatch");

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    const fallback: Record<string, string[]> = {};
    for (const a of articles) fallback[a.title.slice(0, 60)] = [a.id];
    return fallback;
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    const fallback: Record<string, string[]> = {};
    for (const a of articles) fallback[a.title.slice(0, 60)] = [a.id];
    return fallback;
  }
}

// ─── Pass 2: merge cluster names ────────────────────
async function mergeClusters(
  client: Anthropic,
  clusterNames: string[]
): Promise<{ nom_final: string; clusters_inclus: string[] }[]> {
  if (clusterNames.length <= 5) {
    return clusterNames.map((n) => ({ nom_final: n, clusters_inclus: [n] }));
  }

  const MERGE_BATCH = 200;
  if (clusterNames.length > MERGE_BATCH) {
    log(`Merging in batches (${clusterNames.length} clusters)...`);
    const tasks = [];
    for (let i = 0; i < clusterNames.length; i += MERGE_BATCH) {
      const batch = clusterNames.slice(i, i + MERGE_BATCH);
      tasks.push(() => mergeClusters(client, batch));
    }
    const batchResults = await runConcurrent(tasks, MAX_CONCURRENT);
    return batchResults.flat();
  }

  const namesText = clusterNames.map((n, i) => `${i}: ${n}`).join("\n");
  const response = await llmCall(client, {
    model: MODEL,
    max_tokens: 16384,
    messages: [
      {
        role: "user",
        content: `voici une liste d'événements détectés dans la presse. certains sont le même sujet vu sous des angles différents. regroupe-les.

exemples : 'municipales 2026 lyon' + 'municipales 2026 paris' + 'participation municipales' = UN sujet : 'municipales 2026'. 'guerre iran-israël' + 'guerre au moyen-orient' + 'détroit d'ormuz' = UN sujet : 'conflit iran-israël'.

RÈGLE : le nom_final doit être précis, jamais générique.

réponds UNIQUEMENT en JSON brut. un tableau d'objets avec 'nom_final' et 'clusters_inclus' (noms exacts).

Événements :

${namesText}`,
      },
    ],
  }, "mergeClusters");

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return clusterNames.map((n) => ({ nom_final: n, clusters_inclus: [n] }));
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return clusterNames.map((n) => ({ nom_final: n, clusters_inclus: [n] }));
  }
}

// ─── Pass 3: final dedup ────────────────────────────
async function finalDedupCheck(
  client: Anthropic,
  clusterNames: string[]
): Promise<{ from: string[]; to: string }[]> {
  if (clusterNames.length <= 3) return [];

  const response = await llmCall(client, {
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `vérifie qu'il n'y a aucun doublon dans cette liste. si deux sujets parlent de la même chose, fusionne-les. réponds en JSON brut : un tableau de { "from": [...noms], "to": "nom final" }. si rien à fusionner, [].

${clusterNames.join("\n")}`,
      },
    ],
  }, "finalDedupCheck");

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try { return JSON.parse(jsonMatch[0]); } catch { return []; }
}

// ─── DB update ──────────────────────────────────────
async function updateClusters(clusters: Record<string, string[]>): Promise<void> {
  // Batch updates by cluster name
  const entries = Object.entries(clusters);
  const tasks = entries.map(([clusterName, ids]) => async () => {
    for (const id of ids) {
      await supabase
        .from("articles")
        .update({ cluster_id: clusterName })
        .eq("id", id);
    }
  });
  await runConcurrent(tasks, 10);
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

// ─── Main dedup ─────────────────────────────────────
export async function dedup(): Promise<ClusterInfo[]> {
  log("Starting deduplication...");

  const [articles, sourceMap] = await Promise.all([
    fetchAllArticles(),
    fetchSources(),
  ]);
  log(`Found ${articles.length} articles, ${sourceMap.size} sources`);

  if (articles.length === 0) return [];

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const articleMap = new Map(articles.map((a) => [a.id, a]));

  // === PRE-CLUSTER: keyword similarity (no LLM) ===
  const t0 = Date.now();
  const preClusters = preClusterByKeywords(articles);
  const multiArticleClusters = [...preClusters.entries()].filter(([, a]) => a.length >= 2);
  const singleArticles = [...preClusters.entries()].filter(([, a]) => a.length === 1).map(([, a]) => a[0]);

  log(`Pre-cluster: ${articles.length} articles → ${preClusters.size} groups (${multiArticleClusters.length} with 2+ articles, ${singleArticles.length} singles) in ${Date.now() - t0}ms`);

  // === PASS 1: LLM refine only multi-article groups ===
  // Flatten multi-article groups into batches for LLM
  const articlesToCluster: RawArticle[] = [];
  for (const [, arts] of multiArticleClusters) {
    articlesToCluster.push(...arts);
  }
  log(`Pass 1 — sending ${articlesToCluster.length} articles to LLM (${singleArticles.length} singles skip LLM)`);

  let allClusters: Record<string, string[]> = {};

  // Build batches and run in parallel
  const batchTasks: (() => Promise<Record<string, string[]>>)[] = [];
  for (let i = 0; i < articlesToCluster.length; i += LLM_BATCH_SIZE) {
    const batch = articlesToCluster.slice(i, i + LLM_BATCH_SIZE);
    const batchNum = Math.floor(i / LLM_BATCH_SIZE) + 1;
    batchTasks.push(async () => {
      log(`  Pass 1 batch ${batchNum}/${Math.ceil(articlesToCluster.length / LLM_BATCH_SIZE)}...`);
      return clusterBatch(client, batch);
    });
  }

  const batchResults = await runConcurrent(batchTasks, MAX_CONCURRENT);
  for (const clusters of batchResults) {
    for (const [name, ids] of Object.entries(clusters)) {
      if (allClusters[name]) {
        allClusters[name].push(...ids);
      } else {
        allClusters[name] = ids;
      }
    }
  }

  // Add single articles as their own clusters
  for (const a of singleArticles) {
    allClusters[a.title.slice(0, 80)] = [a.id];
  }

  log(`Pass 1 done: ${Object.keys(allClusters).length} clusters`);

  // === PASS 2: merge similar cluster names (parallel batches) ===
  const clusterNames = Object.keys(allClusters);
  log(`Pass 2 — merging ${clusterNames.length} cluster names...`);
  const mergeGroups = await mergeClusters(client, clusterNames);

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

  for (const [name, ids] of Object.entries(allClusters)) {
    if (!usedNames.has(name) && !mergedClusters[name]) {
      mergedClusters[name] = ids;
    }
  }

  log(`Pass 2 done: ${clusterNames.length} → ${Object.keys(mergedClusters).length} clusters`);

  // === PASS 3: final dedup (single call) ===
  const mergedNames = Object.keys(mergedClusters);
  log(`Pass 3 — final dedup check on ${mergedNames.length} names...`);
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
  log(`Pass 3 done: ${pass3Count} fusions`);

  await updateClusters(mergedClusters);

  // Build ClusterInfo
  const clusterInfos: ClusterInfo[] = [];
  for (const [name, ids] of Object.entries(mergedClusters)) {
    const info = buildClusterInfo(name, ids, articleMap, sourceMap);
    if (info) clusterInfos.push(info);
  }

  const sorted = [...clusterInfos].sort((a, b) => b.sources.length - a.sources.length);
  log(`--- Top clusters ---`);
  for (const c of sorted.slice(0, 15)) {
    log(`• ${c.name} (${c.article_ids.length} articles, ${c.source_names.length} sources)`);
  }
  log(`${clusterInfos.length} events from ${articles.length} articles`);

  return clusterInfos;
}

if (require.main === module) {
  dedup().catch((err) => { console.error(err); process.exit(1); });
}
