import { writeFileSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { supabase } from "./db.js";
import { generateAllRecaps, generateMoodBarometer, generateQuiz } from "./summarizer.js";
import type { MoodBarometer, QuizQuestion } from "./summarizer.js";

interface DigestArticle {
  title: string;
  url: string;
  score: number;
  summary: string;
  source_name: string;
}

interface SerializedCluster {
  name: string;
  article_ids: string[];
  source_names: string[];
  orientations: string[]; // normalized: gauche/centre/droite (for diversity score)
  raw_orientations: string[]; // original orientations from DB
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

interface BlindSpot {
  type: "political" | "regional";
  name: string;
  sources: string[];
  label: string;
}

interface CachedData {
  recaps?: Record<string, string>;
  barometer?: MoodBarometer;
  quiz?: QuizQuestion[];
  clusters?: SerializedCluster[];
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [generator] ${msg}`);
}

function formatDateFr(date: Date): string {
  return date.toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function fetchTopArticles(limit = 10): Promise<DigestArticle[]> {
  const { data, error } = await supabase
    .from("articles")
    .select("title, url, score, summary, cluster_id, sources(name)")
    .not("cluster_id", "is", null)
    .not("summary", "is", null)
    .not("score", "is", null)
    .order("score", { ascending: false });

  if (error) throw new Error(`Failed to fetch articles: ${error.message}`);
  if (!data) return [];

  const seen = new Set<string>();
  const result: DigestArticle[] = [];
  for (const row of data) {
    const cluster = row.cluster_id as string;
    if (seen.has(cluster)) continue;
    seen.add(cluster);
    const src = row.sources as unknown as { name: string } | null;
    result.push({
      title: row.title,
      url: row.url,
      score: Number(row.score),
      summary: row.summary!,
      source_name: src?.name ?? "Unknown",
    });
    if (result.length >= limit) break;
  }
  return result;
}

function scanArchiveDates(distDir: string): string[] {
  try {
    const files = readdirSync(distDir);
    return files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
      .map((f) => f.replace(".html", ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function annotationsToTooltips(html: string): string {
  return html.replace(
    /\[\[([^\]]+)\]\]/g,
    '<sup class="tip" onclick="toggleTip(this)">i<span class="tip-text">$1</span></sup>'
  );
}

function stripLinks(html: string): string {
  return html.replace(/<a\s[^>]*>(.*?)<\/a>/gi, "$1");
}

function recapToHtml(recap: string): string {
  let html = recap.trim();
  html = html.replace(/^```(?:html)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  if (!html.startsWith("<p>")) {
    html = html
      .split(/\n\n+/)
      .map((p) => `<p>${p.trim()}</p>`)
      .join("\n");
  }
  html = stripLinks(html);
  html = annotationsToTooltips(html);
  return html;
}

function asciiBar(value: number, max: number, width = 20): string {
  const filled = Math.round((value / max) * width);
  return "█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(width - filled, 0));
}

function buildQuizSection(quiz: QuizQuestion[]): string {
  if (quiz.length === 0) return "";

  const questions = quiz.map((q, i) => {
    const opts = q.options.map((o, j) => {
      return `<label class="quiz-opt" data-q="${i}" data-o="${j}" onclick="checkAnswer(this,${i},${j},${q.answer})"><input type="radio" name="q${i}"> ${escapeHtml(o)}</label>`;
    }).join("\n");

    return `<pre class="quiz-q">${i + 1}. ${escapeHtml(q.question)}</pre>
<div class="quiz-opts">
${opts}
</div>`;
  }).join("\n");

  return `<pre class="dim" style="margin-top:1.5em"><a href="#" onclick="var q=document.getElementById('quiz');q.style.display=q.style.display==='none'?'block':'none';return false">[t'as suivi ?]</a></pre>
<div id="quiz" style="display:none">
${questions}
<pre class="quiz-score" id="quiz-score"></pre>
</div>`;
}

function buildClusterSection(clusters: SerializedCluster[]): string {
  const top = clusters.filter((c) => c.score_final >= 4).slice(0, 7);
  if (top.length === 0) return "";

  const maxSources = Math.max(...top.map((c) => c.num_sources), 1);

  const items = top.map((c) => {
    const bar = asciiBar(c.num_sources, Math.max(maxSources, 8));
    const hasGauche = c.orientations.includes("gauche");
    const hasCentre = c.orientations.includes("centre");
    const hasDroite = c.orientations.includes("droite");
    const diversity = `${hasGauche ? "■" : "□"} gauche  ${hasCentre ? "■" : "□"} centre  ${hasDroite ? "■" : "□"} droite`;

    const shown = c.source_names.slice(0, 6);
    const rest = c.source_names.length - shown.length;
    const sourceList = shown.map((s) => escapeHtml(s)).join(" · ") + (rest > 0 ? ` · [+${rest}]` : "");

    const name = c.name.toLowerCase();
    const streak = (c.streak_days && c.streak_days > 1) ? ` · jour ${c.streak_days}` : "";
    const newTag = c.is_new ? "🔺 " : "";
    const label = `${newTag}${name}${streak}`;
    const pad = Math.max(38 - label.length - 4, 2);
    const header = `── ${label} ${"─".repeat(pad)}`;

    return `<pre class="cluster-header">${header}</pre>
<pre class="cluster-data">  couverture : [${bar}] ${c.num_sources} sources
  diversité  : ${diversity}
  score      : ${c.score_final.toFixed(1)}/10
  en parlent : ${sourceList}</pre>`;
  }).join("\n");

  return `<pre class="sep">────────────────────────────────────────</pre>
<pre class="section-title">pourquoi ces sujets</pre>
${items}`;
}

// Strict blind spots: only flag when 3+ sources from one political side, 0 from the other.
// Exclude service public, spécialisé, régionale from the political count.
function findBlindSpots(clusters: SerializedCluster[]): BlindSpot[] {
  const spots: BlindSpot[] = [];

  for (const c of clusters) {
    const raws = c.raw_orientations ?? [];

    // Count political sources only (exclude service public, spécialisé, régionale)
    let gaucheCount = 0;
    let droiteCount = 0;
    const gaucheSources: string[] = [];
    const droiteSources: string[] = [];

    for (let i = 0; i < raws.length; i++) {
      const o = raws[i]?.toLowerCase() ?? "";
      if (o === "service public" || o === "specialise" || o === "regionale") continue;
      if (o.includes("gauche")) {
        gaucheCount++;
        if (c.source_names[i]) gaucheSources.push(c.source_names[i]);
      } else if (o.includes("droite")) {
        droiteCount++;
        if (c.source_names[i]) droiteSources.push(c.source_names[i]);
      }
    }

    // Strict: 3+ from one side, 0 from the other
    if (gaucheCount >= 3 && droiteCount === 0) {
      spots.push({
        type: "political",
        name: c.name,
        sources: gaucheSources,
        label: "couvert à gauche, ignoré à droite",
      });
    } else if (droiteCount >= 3 && gaucheCount === 0) {
      spots.push({
        type: "political",
        name: c.name,
        sources: droiteSources,
        label: "couvert à droite, ignoré à gauche",
      });
    }
  }

  return spots.slice(0, 3);
}

function buildBlindSpotsSection(clusters: SerializedCluster[]): string {
  const spots = findBlindSpots(clusters);
  if (spots.length === 0) return "";

  const grouped: Record<string, BlindSpot[]> = {};
  for (const s of spots) {
    if (!grouped[s.label]) grouped[s.label] = [];
    grouped[s.label].push(s);
  }

  let html = `<pre class="sep">────────────────────────────────────────</pre>
<pre class="section-title">angles morts</pre>`;

  for (const [label, items] of Object.entries(grouped)) {
    html += `\n<pre class="dim">${label} :</pre>`;
    for (const item of items) {
      const shown = item.sources.slice(0, 4).map((s) => escapeHtml(s)).join(", ");
      html += `\n<pre class="cluster-data">  · ${escapeHtml(item.name).toLowerCase()}
    ${shown}</pre>`;
    }
  }

  return html;
}

function buildPage(
  articles: DigestArticle[],
  date: Date,
  pastDates: string[],
  recaps: Record<string, string>,
  barometer: MoodBarometer,
  clusters: SerializedCluster[],
  quiz: QuizQuestion[],
  yesterdayMood: number | null,
  totalArticles: number,
  activeSources: number
): string {
  const dateFr = formatDateFr(date);
  const dateIso = toISODate(date);

  const seenSources = new Set<string>();
  const sourceLinks = articles
    .filter((a) => {
      const name = a.source_name;
      if (!name || name === "Unknown" || name === "Autre") return false;
      if (seenSources.has(name)) return false;
      seenSources.add(name);
      return true;
    })
    .map((a) => `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.source_name)}</a>`)
    .join(" · ");

  const archiveDates = pastDates.filter((d) => d !== dateIso);
  const archiveSection =
    archiveDates.length > 0
      ? `<pre class="sep">────────────────────────────────────────</pre>
<pre class="section-title">archives</pre>
<pre class="dim">  ${archiveDates.map((d) => `<a href="${d}.html">${d}</a>`).join(" · ")}</pre>`
      : "";

  const filled = Math.round(barometer.mood / 100 * 20);
  const empty = 20 - filled;
  const moodBar = "█".repeat(filled) + "░".repeat(empty);

  const quizSection = buildQuizSection(quiz);
  const clusterSection = buildClusterSection(clusters);
  const blindSpotsSection = buildBlindSpotsSection(clusters);

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>5h07 — ${escapeHtml(dateFr)}</title>
<link rel="alternate" type="application/rss+xml" title="5h07" href="/feed.xml">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="theme-color" content="#000000">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{max-width:700px;margin:0 auto;padding:1.5em 1em;font-family:'Courier New',Courier,monospace;font-size:15px;line-height:1.6;color:#111;background:#FFFCF0;}
pre{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:inherit;line-height:inherit;margin:0;}
a{color:#0057b7;}
.logo{font-size:0.75em;line-height:1.15;margin-bottom:0.5em;color:#333;}
.sep{color:#999;margin:1.2em 0;overflow:hidden;}
.about{font-size:0.82em;color:#888;border-left:2px solid #ddd;padding-left:1em;margin:1em 0 1.5em;}
.baro{font-size:0.9em;margin:0.8em 0 1.5em;color:#555;}
.recap p{margin-bottom:0.8em;text-align:justify;}
.section-title{font-weight:bold;margin-bottom:0.6em;color:#999;font-size:0.78em;}
.cluster-header{color:#999;margin-top:0.6em;font-size:0.75em;}
.cluster-data{font-size:0.72em;color:#aaa;margin-bottom:0.2em;}
.sources{font-size:0.78em;color:#999;margin-top:2em;}
.sources a{color:#999;}
.footer{font-size:0.78em;color:#bbb;margin-top:1em;}
.tip{cursor:pointer;color:#888;font-size:0.75em;margin-left:1px;position:relative;}
.tip-text{display:none;position:absolute;bottom:1.5em;left:0;background:#FFFCF0;border:1px solid #000;padding:0.4em 0.6em;font-size:1.35em;max-width:300px;width:max-content;z-index:10;line-height:1.4;font-style:normal;font-weight:normal;}
.quiz-q{margin-top:0.8em;color:#333;}
.quiz-opts{margin:0.3em 0 0.5em 1.5em;}
.quiz-opt{display:block;cursor:pointer;padding:0.15em 0;font-family:inherit;font-size:inherit;}
.quiz-opt.correct{color:#2a7d2a;}
.quiz-opt.wrong{color:#c0392b;text-decoration:line-through;}
.quiz-opt.reveal{color:#2a7d2a;}
.quiz-score{margin-top:0.8em;color:#555;}
.dim{font-size:0.82em;color:#999;}
.dim a{color:#999;}
</style>
</head>
<body>
<pre class="logo">
 ____  _    ___  _____
| ___|| |  / _ \\|___  |
|___ \\| |_| | | |  / /
 ___) |  _| |_| | / /
|____/|_|  \\___/ /_/
</pre>
<div class="about">
${totalArticles} articles lus ce matin dans ${activeSources} sources françaises.
scorés, triés, résumés. pas de pub, pas d'éditorial, juste les faits.
</div>
<pre class="sep">════════════════════════════════════════</pre>
<pre>${escapeHtml(dateFr)}</pre>
<div class="baro">
<pre>  mood : [${moodBar}] ${barometer.mood}/100 ${barometer.emoji}${yesterdayMood !== null ? (() => { const diff = barometer.mood - yesterdayMood; const abs = Math.abs(diff); if (abs < 5) return ' <span style="color:#999">▸ ' + (diff >= 0 ? '+' : '') + diff + '</span>'; if (diff > 0) return ' <span style="color:#2a7d2a">▲ +' + diff + '</span>'; return ' <span style="color:#c0392b">▼ ' + diff + '</span>'; })() : ''}</pre>
</div>
<div class="recap">
${recapToHtml(recaps["principal"] ?? "")}
</div>
${quizSection}
${clusterSection}
${blindSpotsSection}
<pre class="sep">────────────────────────────────────────</pre>
<div class="sources">sources : ${sourceLinks}</div>
${archiveSection}
<pre class="sep">════════════════════════════════════════</pre>
<pre class="dim">
  cette page pèse ~${Math.round(recapToHtml(recaps["principal"] ?? "").length / 100 + 10)} ko
  0 tracker · 0 pub · 0 cookie · 0 image
  oui, une ia lit ${articles.length * 80}+ articles chaque matin
  c'est toujours moins que vous sur 50 sites
</pre>
<div class="footer">5h07 — l'essentiel de l'actu française, chaque matin à 5h07. scoré par ia, zéro éditorial.</div>
<script>
function toggleTip(el){var t=el.querySelector('.tip-text');if(!t)return;var open=t.style.display==='block';closeAllTips();if(!open)t.style.display='block';}
function closeAllTips(){var a=document.querySelectorAll('.tip-text');for(var i=0;i<a.length;i++)a[i].style.display='none';}
document.addEventListener('click',function(e){if(!e.target.closest('.tip'))closeAllTips();});
var quizDone={};var quizTotal=4;
function checkAnswer(el,q,picked,correct){
  if(quizDone[q])return;quizDone[q]=true;
  var opts=document.querySelectorAll('[data-q="'+q+'"]');
  for(var i=0;i<opts.length;i++){
    if(parseInt(opts[i].dataset.o)===correct)opts[i].classList.add(picked===correct?'correct':'reveal');
    if(parseInt(opts[i].dataset.o)===picked&&picked!==correct)opts[i].classList.add('wrong');
    opts[i].style.pointerEvents='none';
  }
  if(picked===correct)el.innerHTML='✓ '+el.textContent.trim();
  else el.innerHTML='✗ '+el.textContent.trim();
  var done=Object.keys(quizDone).length;
  if(done===quizTotal){
    var right=0;for(var k in quizDone)if(quizDone[k])right++;
    // recount correct
    right=document.querySelectorAll('.quiz-opt.correct').length;
    var msg=right===4?"t'es chaud":right>=3?"pas mal":right>=2?"moyen":"relis le récap";
    document.getElementById('quiz-score').textContent=right+'/'+quizTotal+' — '+msg;
  }
}
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js');}
</script>
</body>
</html>`;
}

function buildFeed(articles: DigestArticle[], date: Date): string {
  const items = articles
    .map(
      (a) => `    <item>
      <title>${escapeHtml(a.title)}</title>
      <link>${escapeHtml(a.url)}</link>
      <description>${escapeHtml(a.summary)}</description>
      <source>${escapeHtml(a.source_name)}</source>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>5h07</title>
    <description>L'essentiel de l'actu française, chaque matin à 5h07.</description>
    <lastBuildDate>${date.toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

export async function generate(): Promise<void> {
  log("Starting site generation...");

  const now = new Date();
  const dateIso = toISODate(now);
  const distDir = path.resolve(process.cwd(), "dist");
  mkdirSync(distDir, { recursive: true });

  const articles = await fetchTopArticles(10);
  log(`Fetched ${articles.length} articles for digest`);

  if (articles.length === 0) {
    log("No articles to generate. Aborting.");
    return;
  }

  const pastDates = scanArchiveDates(distDir);

  // Check cache
  const { data: existing } = await supabase
    .from("daily_digests")
    .select("article_ids")
    .eq("date", dateIso)
    .single();

  let recaps: Record<string, string>;
  let barometer: MoodBarometer;
  let quiz: QuizQuestion[] = [];
  let clusters: SerializedCluster[] = [];

  const cached = existing?.article_ids as CachedData | null;

  clusters = cached?.clusters ?? [];
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const recapArticles = articles.map((a) => ({
    id: a.url,
    title: a.title,
    description: a.summary,
    url: a.url,
    score: a.score,
    source_name: a.source_name,
  }));

  // Use cached recaps (Opus) if available, regenerate only if missing
  if (cached?.recaps) {
    log("Using cached recaps from daily_digests (skipping Opus call)");
    recaps = cached.recaps;
  } else {
    const clusterNames = clusters
      .filter((c) => c.score_final >= 4)
      .slice(0, 7)
      .map((c) => c.name);
    log("Generating recaps (no cache found)...");
    recaps = await generateAllRecaps(client, recapArticles, clusterNames.length > 0 ? clusterNames : undefined);
    log(`✓ All recaps generated`);
  }

  // Use cached barometer/quiz if available, otherwise generate (cheap Haiku calls)
  if (cached?.barometer && cached?.quiz) {
    log("Using cached barometer + quiz from daily_digests");
    barometer = cached.barometer;
    quiz = cached.quiz;
  } else {
    log("Generating barometer + quiz...");
    barometer = await generateMoodBarometer(client, recapArticles);
    log(`✓ Barometer: ${barometer.emoji} ${barometer.mood}/100`);
    quiz = await generateQuiz(client, recaps["principal"] ?? "");
    log(`✓ Quiz: ${quiz.length} questions`);
  }

  // Save everything to cache
  await supabase
    .from("daily_digests")
    .upsert({
      date: dateIso,
      article_ids: { urls: articles.map((a) => a.url), recaps, barometer, quiz, clusters },
    }, { onConflict: "date" });

  // Fetch yesterday's mood for trend arrow
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = toISODate(yesterday);
  const { data: yData } = await supabase
    .from("daily_digests")
    .select("article_ids")
    .eq("date", yesterdayIso)
    .single();
  const yesterdayMood: number | null = (yData?.article_ids as CachedData | null)?.barometer?.mood ?? null;
  if (yesterdayMood !== null) {
    log(`Yesterday's mood: ${yesterdayMood}/100, today: ${barometer.mood}/100 (${barometer.mood - yesterdayMood >= 0 ? "+" : ""}${barometer.mood - yesterdayMood})`);
  }

  // Count today's articles and active sources
  const cutoff = new Date(now);
  cutoff.setHours(cutoff.getHours() - 24);
  const { count: totalArticles } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .gte("published_at", cutoff.toISOString());
  const { data: sourceCounts } = await supabase
    .from("articles")
    .select("source_id")
    .gte("published_at", cutoff.toISOString());
  const activeSources = new Set((sourceCounts ?? []).map((r) => r.source_id)).size;
  log(`Today: ${totalArticles ?? 0} articles from ${activeSources} sources`);

  // Generate pages
  const indexHtml = buildPage(articles, now, pastDates, recaps, barometer, clusters, quiz, yesterdayMood, totalArticles ?? 0, activeSources);
  writeFileSync(path.join(distDir, "index.html"), indexHtml, "utf-8");
  log("✓ dist/index.html");

  const datePage = buildPage(articles, now, pastDates, recaps, barometer, clusters, quiz, yesterdayMood, totalArticles ?? 0, activeSources);
  writeFileSync(path.join(distDir, `${dateIso}.html`), datePage, "utf-8");
  log(`✓ dist/${dateIso}.html`);

  const feed = buildFeed(articles, now);
  writeFileSync(path.join(distDir, "feed.xml"), feed, "utf-8");
  log("✓ dist/feed.xml");

  // Generate admin page
  const adminHtml = buildAdminPage(clusters, dateIso);
  writeFileSync(path.join(distDir, "admin.html"), adminHtml, "utf-8");
  log("✓ dist/admin.html");

  log("Done. Site generated.");
}

function buildAdminPage(clusters: SerializedCluster[], dateIso: string): string {
  const top = [...clusters]
    .sort((a, b) => b.score_final - a.score_final)
    .slice(0, 20);

  const rows = top.map((c, i) => {
    const srcList = c.source_names.slice(0, 5).map((s) => escapeHtml(s)).join(", ");
    const more = c.source_names.length > 5 ? ` +${c.source_names.length - 5}` : "";
    return `<div class="row" data-name="${escapeHtml(c.name)}" data-idx="${i}">
<pre>${escapeHtml(c.name)}</pre>
<pre class="meta">score ${c.score_final.toFixed(1)} · ${c.num_sources} sources · ${srcList}${more}</pre>
<div class="actions">
<button data-action="confirmed">👍 confirmé</button>
<button data-action="overscored">👎 surcoté</button>
<button data-action="underscored">⬆️ sous-coté</button>
<button data-action="irrelevant">🗑️ pas pertinent</button>
</div>
<pre class="status"></pre>
</div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>5h07 admin — ${dateIso}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{max-width:700px;margin:0 auto;padding:1.5em 1em;font-family:'Courier New',Courier,monospace;font-size:14px;line-height:1.5;color:#111;background:#FFFCF0;display:none;}
pre{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:inherit;line-height:inherit;margin:0;}
.row{border-bottom:1px solid #ddd;padding:0.8em 0;}
.meta{font-size:0.8em;color:#888;margin:0.2em 0 0.4em;}
.actions{display:flex;gap:0.4em;flex-wrap:wrap;}
button{font-family:inherit;font-size:0.8em;padding:0.3em 0.6em;cursor:pointer;border:1px solid #ccc;background:#fff;border-radius:2px;}
button:hover{background:#eee;}
button:disabled{opacity:0.4;cursor:default;}
.status{font-size:0.8em;color:#2a7d2a;margin-top:0.2em;}
.missing{margin-top:1.5em;border-top:1px solid #ddd;padding-top:1em;}
.missing input{font-family:inherit;font-size:inherit;padding:0.3em;width:60%;border:1px solid #ccc;}
.missing button{margin-left:0.4em;}
h1{font-size:1.2em;margin-bottom:0.3em;}
.dim{font-size:0.8em;color:#999;}
</style>
</head>
<body>
<h1>5h07 admin</h1>
<pre class="dim">${dateIso} · ${top.length} sujets</pre>
<br>
${rows}
<div class="missing">
<pre>sujet manquant :</pre>
<input type="text" id="missing-input" placeholder="ex: grève SNCF">
<button onclick="addMissing()">ajouter</button>
<pre class="status" id="missing-status"></pre>
</div>
<script>
var SB_URL='${config.supabaseUrl}';
var SB_KEY='${config.supabaseAnonKey}';
var TODAY='${dateIso}';

(function(){
  var p=prompt('mot de passe admin');
  if(p!=='${config.adminPassword}'){document.body.innerHTML='<pre>accès refusé</pre>';document.body.style.display='block';return;}
  document.body.style.display='block';

  function normalize(s){return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\\s+/g,' ').trim();}
  function words(s){var stop=['le','la','les','de','du','des','un','une','et','en','au','aux','a','ce','est','sur','par','pour','dans','avec'];var w=normalize(s).split(' ');return w.filter(function(x){return x.length>2&&stop.indexOf(x)<0;});}
  function fuzzy(a,b){var wa=words(a),wb=words(b);if(wa.length===0||wb.length===0)return 0;var match=0;for(var i=0;i<wa.length;i++){if(wb.indexOf(wa[i])>=0)match++;}return match/Math.max(wa.length,wb.length);}

  // Load existing feedback for today
  fetch(SB_URL+'/rest/v1/feedback?date=eq.'+TODAY+'&select=cluster_name,action',{
    headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY}
  }).then(function(r){return r.json()}).then(function(data){
    var rows=document.querySelectorAll('.row');
    for(var i=0;i<rows.length;i++){
      var name=rows[i].dataset.name;
      var bestScore=0,bestAction=null;
      for(var j=0;j<data.length;j++){
        var score=(data[j].cluster_name===name)?1:fuzzy(data[j].cluster_name,name);
        if(score>bestScore){bestScore=score;bestAction=data[j].action;}
      }
      if(bestScore>=0.5&&bestAction){
        var btns=rows[i].querySelectorAll('button');
        for(var k=0;k<btns.length;k++)btns[k].disabled=true;
        rows[i].querySelector('.status').textContent='\\u2713 '+bestAction;
      }
    }
  });
})();

document.addEventListener('click',function(e){
  var btn=e.target.closest('button[data-action]');
  if(!btn)return;
  var row=btn.closest('.row');
  if(!row)return;
  var name=row.dataset.name;
  var action=btn.dataset.action;
  var btns=row.querySelectorAll('button');
  for(var i=0;i<btns.length;i++)btns[i].disabled=true;
  fetch(SB_URL+'/rest/v1/feedback',{
    method:'POST',
    headers:{'Content-Type':'application/json','apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Prefer':'return=minimal'},
    body:JSON.stringify({date:TODAY,cluster_name:name,action:action})
  }).then(function(r){
    row.querySelector('.status').textContent=r.ok?'✓ enregistré':'✗ erreur';
  });
});

function addMissing(){
  var v=document.getElementById('missing-input').value.trim();
  if(!v)return;
  fetch(SB_URL+'/rest/v1/feedback',{
    method:'POST',
    headers:{'Content-Type':'application/json','apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY},
    body:JSON.stringify({date:TODAY,cluster_name:v,action:'missing'})
  }).then(function(r){
    document.getElementById('missing-status').textContent=r.ok?'✓ ajouté':'✗ erreur';
    document.getElementById('missing-input').value='';
  });
}
</script>
</body>
</html>`;
}

// Run directly
if (require.main === module) {
  generate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
