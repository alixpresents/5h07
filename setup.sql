-- 5h07 — Supabase schema setup
-- Run this in the Supabase SQL Editor

-- Table: sources
CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  rss_url text NOT NULL,
  orientation text DEFAULT 'centre',
  category text DEFAULT 'généraliste',
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Table: articles
CREATE TABLE articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES sources(id),
  title text NOT NULL,
  description text,
  url text UNIQUE NOT NULL,
  published_at timestamptz,
  score decimal,
  summary text,
  cluster_id text,
  newsletter_date date,
  created_at timestamptz DEFAULT now()
);

-- Table: daily_digests
CREATE TABLE daily_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date UNIQUE NOT NULL,
  article_ids jsonb,
  generated_at timestamptz DEFAULT now()
);

-- Index for faster queries
CREATE INDEX idx_articles_published_at ON articles(published_at);
CREATE INDEX idx_articles_score ON articles(score);
CREATE INDEX idx_articles_newsletter_date ON articles(newsletter_date);
CREATE INDEX idx_articles_source_id ON articles(source_id);
CREATE INDEX idx_articles_cluster_id ON articles(cluster_id);

-- Seed sources
INSERT INTO sources (name, rss_url, orientation, category) VALUES
  -- Presse nationale généraliste
  ('Le Monde', 'https://www.lemonde.fr/rss/une.xml', 'centre-gauche', 'nationale'),
  ('Le Figaro', 'https://www.lefigaro.fr/rss/figaro_actualites.xml', 'droite', 'nationale'),
  ('Libération', 'https://www.liberation.fr/arc/outboundfeeds/rss-all/collection/accueil-702/?outputType=xml', 'gauche', 'nationale'),
  ('20 Minutes', 'https://www.20minutes.fr/feeds/rss-une.xml', 'centre', 'nationale'),
  ('Le Parisien', 'https://www.leparisien.fr/arc/outboundfeeds/rss/collection/a-la-une/', 'centre', 'nationale'),
  ('La Croix', 'https://www.la-croix.com/RSS/UNIVERS', 'centre', 'nationale'),
  ('L''Humanité', 'https://www.humanite.fr/feed', 'gauche', 'nationale'),
  -- Info continue / TV / radio
  ('France Info', 'https://www.francetvinfo.fr/titres.rss', 'service public', 'info continue'),
  ('BFM TV', 'https://www.bfmtv.com/rss/news-24-7/', 'centre-droit', 'info continue'),
  ('France 24', 'https://www.france24.com/fr/rss', 'service public', 'info continue'),
  ('RFI', 'https://www.rfi.fr/fr/rss', 'service public', 'info continue'),
  ('Arte Info', 'https://www.arte.tv/fr/afp/latest', 'service public', 'info continue'),
  ('LCI', 'https://www.lci.fr/rss.xml', 'centre-droit', 'info continue'),
  ('Europe 1', 'https://www.europe1.fr/rss.xml', 'droite', 'info continue'),
  -- Magazines / hebdos
  ('Le Point', 'https://www.lepoint.fr/rss.xml', 'centre-droit', 'magazine'),
  ('L''Express', 'https://www.lexpress.fr/arc/outboundfeeds/rss/alaune.xml', 'centre-droit', 'magazine'),
  ('L''Obs', 'https://www.nouvelobs.com/rss.xml', 'centre-gauche', 'magazine'),
  ('Marianne', 'https://www.marianne.net/rss.xml', 'gauche souverainiste', 'magazine'),
  ('Courrier International', 'https://www.courrierinternational.com/feed/all/rss.xml', 'centre', 'magazine'),
  ('Politis', 'https://www.politis.fr/feed/', 'gauche', 'magazine'),
  ('Valeurs Actuelles', 'https://www.valeursactuelles.com/feed', 'droite', 'magazine'),
  -- Économie / business
  ('Les Echos', 'https://www.lesechos.fr/rss/rss_une.xml', 'centre-droit', 'économie'),
  ('La Tribune', 'https://www.latribune.fr/rss/rubriques/actualite.html', 'centre', 'économie'),
  ('Capital', 'https://www.capital.fr/feeds/rss', 'centre', 'économie'),
  ('L''Usine Nouvelle', 'https://www.usinenouvelle.com/rss/', 'spécialisé', 'économie'),
  ('Challenges', 'https://www.challenges.fr/rss.xml', 'centre-droit', 'économie'),
  -- Tech / science
  ('Numerama', 'https://www.numerama.com/feed/', 'spécialisé', 'tech'),
  ('Next', 'https://next.ink/feed/', 'spécialisé', 'tech'),
  ('Futura Sciences', 'https://www.futura-sciences.com/rss/actualites.xml', 'spécialisé', 'tech'),
  -- Environnement / société
  ('Reporterre', 'https://reporterre.net/spip.php?page=backend', 'gauche écolo', 'environnement'),
  ('Alternatives Économiques', 'https://www.alternatives-economiques.fr/rss.xml', 'centre-gauche', 'environnement'),
  ('Mediapart', 'https://www.mediapart.fr/articles/feed', 'gauche', 'investigation'),
  ('Basta!', 'https://basta.media/spip.php?page=backend', 'gauche', 'investigation'),
  -- Investigation / opinion
  ('Blast', 'https://www.blast-info.fr/feed', 'gauche', 'investigation'),
  -- Presse régionale
  ('Ouest-France', 'https://www.ouest-france.fr/rss.xml', 'centre', 'régionale'),
  ('Sud Ouest', 'https://www.sudouest.fr/rss.xml', 'centre', 'régionale'),
  ('La Dépêche', 'https://www.ladepeche.fr/rss.xml', 'centre', 'régionale'),
  ('La Voix du Nord', 'https://www.lavoixdunord.fr/rss.xml', 'centre', 'régionale'),
  ('Le Progrès', 'https://www.leprogres.fr/rss.xml', 'centre', 'régionale'),
  ('Le Télégramme', 'https://www.letelegramme.fr/rss.xml', 'centre', 'régionale'),
  ('La Provence', 'https://www.laprovence.com/rss.xml', 'centre', 'régionale'),
  ('Le Dauphiné', 'https://www.ledauphine.com/rss.xml', 'centre', 'régionale'),
  ('Dernières Nouvelles d''Alsace', 'https://www.dna.fr/rss.xml', 'centre', 'régionale'),
  ('Midi Libre', 'https://www.midilibre.fr/rss.xml', 'centre', 'régionale'),
  ('Nice Matin', 'https://www.nicematin.com/rss.xml', 'centre', 'régionale'),
  ('Actu.fr', 'https://www.actu.fr/feed', 'centre', 'régionale'),
  -- International vu de France
  ('Huffington Post FR', 'https://www.huffingtonpost.fr/feeds/index.xml', 'centre-gauche', 'internationale'),
  ('Slate FR', 'https://www.slate.fr/rss.xml', 'centre', 'internationale');
