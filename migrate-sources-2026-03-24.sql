-- Migration 2026-03-24: fix broken RSS URLs, add new feeds, deactivate dead sources

-- ─── Update existing sources with working URLs ───────────────────

-- Libération: split into politique + international
UPDATE sources SET name = 'Libération (politique)', rss_url = 'https://www.liberation.fr/arc/outboundfeeds/rss-all/category/politique/?outputType=xml'
  WHERE name = 'Libération';

INSERT INTO sources (name, rss_url, orientation, category) VALUES
  ('Libération (international)', 'https://www.liberation.fr/arc/outboundfeeds/rss-all/category/international/?outputType=xml', 'gauche', 'nationale');

-- Le Progrès: split into une + france-monde
UPDATE sources SET rss_url = 'https://www.leprogres.fr/rss'
  WHERE name = 'Le Progrès';

INSERT INTO sources (name, rss_url, orientation, category) VALUES
  ('Le Progrès (france-monde)', 'https://www.leprogres.fr/france-monde/rss', 'centre', 'régionale');

-- Capital: new Prisma Media feed
UPDATE sources SET rss_url = 'https://feed.prismamediadigital.com/v1/cap/rss?sources=capital,capital-avec-agence-france-presse,capital-avec-reuters'
  WHERE name = 'Capital';

-- LCI → TF1 Info (rebrand)
UPDATE sources SET name = 'TF1 Info (ex-LCI)', rss_url = 'https://www.tf1info.fr/feeds/rss-une.xml'
  WHERE name = 'LCI';

-- Le Point
UPDATE sources SET rss_url = 'https://www.lepoint.fr/rss'
  WHERE name = 'Le Point';

-- Politis
UPDATE sources SET rss_url = 'https://www.politis.fr/flux-rss/'
  WHERE name = 'Politis';

-- Blast
UPDATE sources SET rss_url = 'https://api.blast-info.fr/rss.xml'
  WHERE name = 'Blast';

-- Le Télégramme (URL OK, mais confirmer)
UPDATE sources SET rss_url = 'https://www.letelegramme.fr/rss.xml'
  WHERE name = 'Le Télégramme';

-- Le Dauphiné
UPDATE sources SET rss_url = 'https://www.ledauphine.com/rss'
  WHERE name = 'Le Dauphiné';

-- DNA
UPDATE sources SET rss_url = 'https://www.dna.fr/rss'
  WHERE name LIKE 'Dernières Nouvelles%';

-- Nice Matin
UPDATE sources SET rss_url = 'https://www.nicematin.com/rss'
  WHERE name = 'Nice Matin';

-- Actu.fr
UPDATE sources SET rss_url = 'https://www.actu.fr/rss.xml'
  WHERE name = 'Actu.fr';

-- ─── Deactivate dead sources ─────────────────────────────────────

UPDATE sources SET active = false WHERE name = 'Marianne';
UPDATE sources SET active = false WHERE name = 'Les Echos';
UPDATE sources SET active = false WHERE name LIKE 'L''Usine Nouvelle%';
UPDATE sources SET active = false WHERE name = 'La Provence';
UPDATE sources SET active = false WHERE name = 'Arte Info';
