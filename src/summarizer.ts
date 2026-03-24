import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { supabase } from "./db.js";
import { llmCall, HAIKU, SONNET, OPUS } from "./llm.js";

export interface Persona {
  id: string;
  label: string;
  prompt: string;
}

export const PERSONAS: Persona[] = [
  {
    id: "principal",
    label: "récap",
    prompt: `tu rédiges le récap quotidien de 5h07. tu t'appelles pas, tu te présentes pas, tu écris juste.

ton style : t'es ce pote qui lit tout et qui te résume la journée au café. pas un journaliste, pas un prof. quelqu'un de cultivé qui parle normalement. tu peux te permettre une réaction honnête de temps en temps ('c'est pas anodin', 'on en reparlera', 'là c'est du lourd'), mais sans forcer. t'es pas là pour faire le malin, t'es là pour que le lecteur comprenne ce qui se passe.

les règles :
- sois concis : 600-900 mots max, pas un mot de trop
- vulgarise tout : si un terme n'est pas compris par quelqu'un qui n'a pas suivi l'actu cette semaine, explique-le ou utilise une annotation [[explication]]
- contextualise en une phrase max par sujet : ce qui s'est passé avant, pourquoi ça arrive maintenant
- dis l'impact concret : en quoi ça change quelque chose pour les gens
- sois neutre sur les faits, humain dans le ton
- pas de jargon politique, pas de 'notons que', pas de 'il convient de', pas de 'dans un contexte de'
- des paragraphes courts, 2-4 phrases max
- chaque paragraphe commence par un titre de 2-5 mots en gras (<strong>titre</strong>) qui résume le sujet, suivi du texte. exemples : <strong>Philippe réélu au Havre.</strong>, <strong>Ormuz au bord de la fermeture.</strong>, <strong>L'eau, arme de guerre.</strong>
- commence direct par le sujet le plus important
- finis par une phrase courte qui donne le ton de la journée

tu ne prends pas parti mais tu ne fais pas semblant d'être un robot. t'as le droit d'avoir un regard.

pour les termes importants que tout le monde ne connaît pas, ajoute une annotation entre doubles crochets : terme [[explication courte d'une phrase]]. ne surexplique pas les trucs évidents. 5-8 annotations max.

n'insère aucun lien dans le texte. tu écris en html (<p> pour les paragraphes). pas de markdown, pas de balises <a>.`,
  },
];

interface ArticleToSummarize {
  id: string;
  title: string;
  description: string | null;
  url?: string;
  score: number;
  source_name?: string;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [summarizer] ${msg}`);
}

async function fetchTopArticles(limit: number): Promise<ArticleToSummarize[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("id, title, description, url, score, cluster_id, source_id, sources(name)")
    .not("cluster_id", "is", null)
    .not("score", "is", null)
    .order("score", { ascending: false });

  if (error) throw new Error(`Failed to fetch articles: ${error.message}`);
  if (!data || data.length === 0) return [];

  const seen = new Set<string>();
  const deduped: ArticleToSummarize[] = [];
  for (const row of data) {
    const cluster = row.cluster_id as string;
    if (seen.has(cluster)) continue;
    seen.add(cluster);
    const src = row.sources as unknown as { name: string } | null;
    deduped.push({
      id: row.id,
      title: row.title,
      description: row.description,
      url: row.url,
      score: Number(row.score),
      source_name: src?.name ?? "Unknown",
    });
  }

  return deduped.slice(0, limit);
}

async function generateSummaries(
  client: Anthropic,
  articles: ArticleToSummarize[]
): Promise<{ id: string; summary: string }[]> {
  const articlesText = articles
    .map(
      (a) =>
        `- ID: ${a.id}\n  Titre: ${a.title}\n  Description: ${a.description ?? "(aucune)"}`
    )
    .join("\n\n");

  const response = await llmCall(client, {
    model: HAIKU,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `Pour chaque article ci-dessous, génère un résumé de 2-3 phrases. Le résumé doit être original (pas un copier-coller du titre ou de la description), factuel, et neutre.

Réponds UNIQUEMENT en JSON : un tableau d'objets avec 'id' et 'summary'.

Articles :

${articlesText}`,
      },
    ],
  }, "summaries");

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`No JSON array found in response: ${text.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]);
}

export async function generateDailyRecap(
  client: Anthropic,
  articles: ArticleToSummarize[],
  persona: Persona,
  clusterNames?: string[]
): Promise<string> {
  const eventsText = articles
    .map((a) => `- ${a.title} (${a.source_name})\n  URL: ${a.url ?? "n/a"}\n  Description: ${a.description ?? "pas de description"}`)
    .join("\n\n");

  const clusterContext = clusterNames && clusterNames.length > 0
    ? `\n\nIMPORTANT : ton récap doit couvrir exactement ces ${clusterNames.length} sujets (et seulement ceux-là), dans cet ordre de priorité :\n${clusterNames.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\nchaque sujet de cette liste doit avoir AU MINIMUM une phrase dans le récap. aucun sujet ne doit être ignoré. n'en invente pas d'autres.`
    : "";

  const response = await llmCall(client, {
    model: OPUS,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `${persona.prompt}${clusterContext}\n\nÉvénements du jour :\n\n${eventsText}`,
      },
    ],
  }, "recap");

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  return text.trim();
}

export interface FilmReco {
  titre: string;
  realisateur: string;
  annee: number;
  lien: string;
}

export async function generateFilmReco(
  client: Anthropic,
  articles: ArticleToSummarize[]
): Promise<FilmReco> {
  const eventsText = articles.slice(0, 5)
    .map((a) => `- ${a.title}`)
    .join("\n");

  const response = await llmCall(client, {
    model: SONNET,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `à partir des thèmes du jour, recommande un seul film en lien avec l'actualité. pas forcément littéral : un lien thématique, une atmosphère, une résonance. privilégie le cinéma français et international de qualité (pas de blockbuster hollywoodien sauf si c'est vraiment pertinent). réponds UNIQUEMENT en JSON brut (pas de markdown) :
- titre : titre du film
- realisateur : nom du réalisateur
- annee : année de sortie
- lien : une phrase de 10 mots max qui fait le pont entre le film et l'actu du jour, sans expliquer le film

Thèmes du jour :

${eventsText}`,
      },
    ],
  }, "filmReco");

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { titre: "La Haine", realisateur: "Mathieu Kassovitz", annee: 1995, lien: "la chute, c'est pas le plus dur" };
  }
  return JSON.parse(jsonMatch[0]);
}

export interface MoodBarometer {
  mood: number;
  emoji: string;
  meteo: string;
  phrase: string;
}

export async function generateMoodBarometer(
  client: Anthropic,
  articles: ArticleToSummarize[]
): Promise<MoodBarometer> {
  const eventsText = articles
    .map((a) => `- ${a.title}`)
    .join("\n");

  const response = await llmCall(client, {
    model: HAIKU,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `à partir de ces événements du jour, évalue l'ambiance générale de la journée. réponds UNIQUEMENT en JSON avec :
- mood : un chiffre de 0 à 100 (0 = journée catastrophique, 50 = neutre, 100 = que des bonnes nouvelles)
- emoji : un seul emoji qui résume le mood
- meteo : un mot météo en français qui correspond (tempête, orage, gris, couvert, variable, nuageux, éclaircie, beau temps, grand soleil)
- phrase : une micro-phrase de 5-8 mots max qui résume la journée en ton 5h07 (ex: 'on a vu pire mais bon', 'journée lourde, café serré', 'une éclaircie dans le chaos', 'ça va pas fort fort')

Événements :

${eventsText}`,
      },
    ],
  }, "barometer");

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { mood: 50, emoji: "☁️", meteo: "couvert", phrase: "journée inclassable" };
  }
  return JSON.parse(jsonMatch[0]);
}

export interface QuizQuestion {
  question: string;
  options: string[];
  answer: number;
}

export async function generateQuiz(
  client: Anthropic,
  recap: string
): Promise<QuizQuestion[]> {
  const response = await llmCall(client, {
    model: HAIKU,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `à partir de ce récap d'actualité, génère exactement 4 questions à choix multiples pour tester si le lecteur a retenu les infos clés. chaque question a 3 options dont une seule est correcte. les questions doivent porter sur des faits précis du récap, pas des opinions. réponds UNIQUEMENT en JSON brut (pas de markdown) : un tableau d'objets avec 'question', 'options' (tableau de 3 strings), 'answer' (index 0-2 de la bonne réponse).

Récap :

${recap}`,
      },
    ],
  }, "quiz");

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }
}

export async function generateAllRecaps(
  client: Anthropic,
  articles: ArticleToSummarize[],
  clusterNames?: string[]
): Promise<Record<string, string>> {
  const results = await Promise.all(
    PERSONAS.map(async (persona) => {
      log(`Generating ${persona.id}'s recap...`);
      const recap = await generateDailyRecap(client, articles, persona, clusterNames);
      log(`✓ ${persona.id}'s recap generated (${recap.length} chars)`);
      return [persona.id, recap] as const;
    })
  );
  return Object.fromEntries(results);
}

async function saveSummaries(
  summaries: { id: string; summary: string }[]
): Promise<void> {
  for (const { id, summary } of summaries) {
    const { error } = await supabase
      .from("articles")
      .update({ summary })
      .eq("id", id);

    if (error) {
      log(`Failed to save summary for ${id}: ${error.message}`);
    }
  }
}

export async function summarize(limit = 10, clusterNames?: string[]): Promise<{ recaps: Record<string, string> }> {
  log("Starting summarization...");

  const articles = await fetchTopArticles(limit);
  log(`Found ${articles.length} top articles to summarize`);

  if (articles.length === 0) {
    log("Nothing to summarize.");
    return { recaps: {} };
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  log("Generating article summaries via Haiku...");
  const summaries = await generateSummaries(client, articles);
  await saveSummaries(summaries);
  log(`✓ ${summaries.length} article summaries saved`);

  const recaps = await generateAllRecaps(client, articles, clusterNames);

  // Display
  for (const persona of PERSONAS) {
    console.log(`\n--- RECAP ${persona.id.toUpperCase()} ---`);
    console.log(recaps[persona.id]);
  }

  log("Done.");
  return { recaps };
}

// Run directly
if (require.main === module) {
  summarize().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
