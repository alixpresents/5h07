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

  // Batch insert, ignore duplicates (url is UNIQUE)
  const { data, error } = await supabase
    .from("articles")
    .upsert(articles, { onConflict: "url", ignoreDuplicates: true })
    .select("id");

  if (error) throw new Error(`Failed to insert articles: ${error.message}`);
  return data?.length ?? 0;
}

export async function scrape(): Promise<void> {
  log("Starting RSS scrape...");

  const sources = await fetchSources();
  log(`Found ${sources.length} active sources`);

  let totalNew = 0;
  let totalFetched = 0;

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

  log(`Done. ${totalFetched} articles fetched, ${totalNew} new inserted.`);
}

// Run directly
if (require.main === module) {
  scrape().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
