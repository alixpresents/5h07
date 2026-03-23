import Parser from "rss-parser";
import { supabase } from "./db.js";

interface Source {
  id: string;
  name: string;
  rss_url: string;
}

interface RawArticle {
  source_id: string;
  title: string;
  description: string | null;
  url: string;
  published_at: string | null;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [scraper] ${msg}`);
}

function stripHtml(html: string | undefined): string | null {
  if (!html) return null;
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// ─── Source matching ────────────────────────────────

let sourceNameMap: Map<string, string> | null = null;

async function getSourceNameMap(): Promise<Map<string, string>> {
  if (sourceNameMap) return sourceNameMap;
  const { data } = await supabase.from("sources").select("id, name").eq("active", true);
  sourceNameMap = new Map<string, string>();
  for (const s of data ?? []) {
    sourceNameMap.set(s.name.toLowerCase(), s.id);
  }
  return sourceNameMap;
}

async function matchSourceId(publisherName: string): Promise<string | null> {
  const map = await getSourceNameMap();
  const lower = publisherName.toLowerCase().trim();

  // Direct match
  if (map.has(lower)) return map.get(lower)!;

  // Fuzzy: check if publisher contains or is contained by a known source
  for (const [name, id] of map) {
    if (lower.includes(name) || name.includes(lower)) return id;
  }
  return null;
}

// ─── Fallback source for unmatched articles ─────────

let fallbackSourceId: string | null = null;

async function getFallbackSourceId(): Promise<string> {
  if (fallbackSourceId) return fallbackSourceId;

  // Get or create an "Autre" source
  const { data: existing } = await supabase
    .from("sources")
    .select("id")
    .eq("name", "Autre")
    .single();

  if (existing) {
    fallbackSourceId = existing.id as string;
    return fallbackSourceId;
  }

  const { data: created } = await supabase
    .from("sources")
    .insert({ name: "Autre", rss_url: "", orientation: "autre", category: "autre", active: false })
    .select("id")
    .single();

  fallbackSourceId = created!.id as string;
  return fallbackSourceId;
}

// ─── RSS feed scraping ──────────────────────────────

async function fetchSources(): Promise<Source[]> {
  const { data, error } = await supabase
    .from("sources")
    .select("id, name, rss_url")
    .eq("active", true);

  if (error) throw new Error(`Failed to fetch sources: ${error.message}`);
  return data ?? [];
}

async function fetchFeed(source: Source): Promise<RawArticle[]> {
  const parser = new Parser({
    timeout: 15_000,
    headers: {
      "User-Agent": "5h07-bot/1.0",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });

  const feed = await parser.parseURL(source.rss_url);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const articles: RawArticle[] = [];
  for (const item of feed.items) {
    if (!item.link || !item.title) continue;

    const pubDate = item.pubDate ? new Date(item.pubDate) : null;
    if (pubDate && pubDate < cutoff) continue;

    articles.push({
      source_id: source.id,
      title: item.title.trim(),
      description: stripHtml(item.contentSnippet || item.content || item.summary),
      url: item.link.trim(),
      published_at: pubDate?.toISOString() ?? null,
    });
  }

  return articles;
}

async function insertArticles(articles: RawArticle[]): Promise<number> {
  if (articles.length === 0) return 0;

  const { data, error } = await supabase
    .from("articles")
    .upsert(articles, { onConflict: "url", ignoreDuplicates: true })
    .select("id");

  if (error) throw new Error(`Failed to insert articles: ${error.message}`);
  return data?.length ?? 0;
}

// ─── Google News RSS ────────────────────────────────

const GOOGLE_NEWS_FEEDS = [
  { name: "Google News France", url: "https://news.google.com/rss?hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Google News Monde", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtWnlHZ0pHVWlnQVAB?hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Google News Économie", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtWnlHZ0pHVWlnQVAB?hl=fr&gl=FR&ceid=FR:fr" },
  { name: "Google News Science/Tech", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtWnlHZ0pHVWlnQVAB?hl=fr&gl=FR&ceid=FR:fr" },
];

async function scrapeGoogleNews(): Promise<{ fetched: number; inserted: number }> {
  const parser = new Parser({
    timeout: 15_000,
    headers: { "User-Agent": "5h07-bot/1.0" },
    customFields: { item: [["source", "source"]] },
  });

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let totalFetched = 0;
  let totalInserted = 0;

  for (const gfeed of GOOGLE_NEWS_FEEDS) {
    try {
      const feed = await parser.parseURL(gfeed.url);
      const articles: RawArticle[] = [];

      for (const item of feed.items) {
        if (!item.link || !item.title) continue;
        const pubDate = item.pubDate ? new Date(item.pubDate) : null;
        if (pubDate && pubDate < cutoff) continue;

        // Extract real source name from <source> tag
        const publisherName = (item as unknown as Record<string, unknown>).source as string | undefined;
        const sourceId = publisherName ? await matchSourceId(publisherName) : null;
        const finalSourceId = sourceId ?? await getFallbackSourceId();

        articles.push({
          source_id: finalSourceId,
          title: item.title.trim(),
          description: stripHtml(item.contentSnippet || item.content || item.summary),
          url: item.link.trim(),
          published_at: pubDate?.toISOString() ?? null,
        });
      }

      totalFetched += articles.length;
      if (articles.length > 0) {
        const inserted = await insertArticles(articles);
        totalInserted += inserted;
        log(`✓ ${gfeed.name}: ${articles.length} articles, ${inserted} new`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ ${gfeed.name}: FAILED — ${msg}`);
    }
  }

  return { fetched: totalFetched, inserted: totalInserted };
}

// ─── NewsAPI ────────────────────────────────────────

async function scrapeNewsAPI(): Promise<{ fetched: number; inserted: number }> {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) {
    log("⊘ NewsAPI: no API key, skipping");
    return { fetched: 0, inserted: 0 };
  }

  try {
    const resp = await fetch(
      `https://newsapi.org/v2/everything?q=france&language=fr&sortBy=publishedAt&pageSize=100&apiKey=${apiKey}`
    );
    if (!resp.ok) {
      log(`✗ NewsAPI: HTTP ${resp.status}`);
      return { fetched: 0, inserted: 0 };
    }

    const json = await resp.json() as {
      articles: { title: string; url: string; description: string | null; publishedAt: string; source: { name: string } }[];
    };

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const articles: RawArticle[] = [];

    for (const item of json.articles ?? []) {
      if (!item.url || !item.title || item.title === "[Removed]") continue;
      const pubDate = item.publishedAt ? new Date(item.publishedAt) : null;
      if (pubDate && pubDate < cutoff) continue;

      const sourceId = await matchSourceId(item.source.name);
      const finalSourceId = sourceId ?? await getFallbackSourceId();

      articles.push({
        source_id: finalSourceId,
        title: item.title.trim(),
        description: item.description?.trim() ?? null,
        url: item.url.trim(),
        published_at: pubDate?.toISOString() ?? null,
      });
    }

    const inserted = await insertArticles(articles);
    log(`✓ NewsAPI: ${articles.length} articles, ${inserted} new`);
    return { fetched: articles.length, inserted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ NewsAPI: FAILED — ${msg}`);
    return { fetched: 0, inserted: 0 };
  }
}

// ─── NewsData.io API ────────────────────────────────

async function scrapeNewsData(): Promise<{ fetched: number; inserted: number }> {
  const apiKey = process.env.NEWSDATA_KEY;
  if (!apiKey) {
    log("⊘ NewsData: no API key, skipping");
    return { fetched: 0, inserted: 0 };
  }

  try {
    const resp = await fetch(
      `https://newsdata.io/api/1/latest?apikey=${apiKey}&country=fr&language=fr&size=50`
    );
    if (!resp.ok) {
      log(`✗ NewsData: HTTP ${resp.status}`);
      return { fetched: 0, inserted: 0 };
    }

    const json = await resp.json() as {
      results: { title: string; link: string; description: string | null; pubDate: string; source_name: string }[];
    };

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const articles: RawArticle[] = [];

    for (const item of json.results ?? []) {
      if (!item.link || !item.title) continue;
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      if (pubDate && pubDate < cutoff) continue;

      const sourceId = item.source_name ? await matchSourceId(item.source_name) : null;
      const finalSourceId = sourceId ?? await getFallbackSourceId();

      articles.push({
        source_id: finalSourceId,
        title: item.title.trim(),
        description: item.description?.trim() ?? null,
        url: item.link.trim(),
        published_at: pubDate?.toISOString() ?? null,
      });
    }

    const inserted = await insertArticles(articles);
    log(`✓ NewsData: ${articles.length} articles, ${inserted} new`);
    return { fetched: articles.length, inserted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ NewsData: FAILED — ${msg}`);
    return { fetched: 0, inserted: 0 };
  }
}

// ─── Main scrape function ───────────────────────────

export async function scrape(): Promise<void> {
  log("Starting scrape...");
  let totalFetched = 0;
  let totalNew = 0;

  // 1. RSS sources (the core ~50 with orientations)
  const sources = await fetchSources();
  log(`Found ${sources.length} RSS sources`);

  for (const source of sources) {
    try {
      const articles = await fetchFeed(source);
      totalFetched += articles.length;
      if (articles.length > 0) {
        const inserted = await insertArticles(articles);
        totalNew += inserted;
        log(`✓ ${source.name}: ${articles.length} articles fetched, ${inserted} new`);
      } else {
        log(`✓ ${source.name}: 0 articles (empty or all older than 24h)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ ${source.name}: FAILED — ${msg}`);
    }
  }

  log(`RSS done: ${totalFetched} fetched, ${totalNew} new`);

  // 2. Google News RSS
  log("--- Google News ---");
  const gn = await scrapeGoogleNews();
  totalFetched += gn.fetched;
  totalNew += gn.inserted;

  // 3. NewsAPI
  log("--- NewsAPI ---");
  const na = await scrapeNewsAPI();
  totalFetched += na.fetched;
  totalNew += na.inserted;

  // 4. NewsData.io
  log("--- NewsData ---");
  const nc = await scrapeNewsData();
  totalFetched += nc.fetched;
  totalNew += nc.inserted;

  log(`Done. Total: ${totalFetched} articles fetched, ${totalNew} new inserted.`);
}

// Run directly
if (require.main === module) {
  scrape().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
