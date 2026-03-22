# 5h07

## Concept
Chaque matin à 5h07, un pipeline automatisé lit ~50 sources de presse française, croise leurs couvertures, score les sujets par un algorithme multi-signal transparent, et génère un site statique avec le récap du jour. Zéro intervention humaine.

Le site montre non seulement ce qui se passe, mais pourquoi ces sujets ont été retenus : combien de médias en parlent, la diversité politique de la couverture, et l'ampleur de l'événement.

## Stack technique
- Runtime : Node.js / TypeScript
- Base de données : Supabase (PostgreSQL, free tier, projet dédié)
- LLM : Claude Haiku (API Anthropic, modèle claude-haiku-4-5-20251001)
- Site : HTML statique généré par le pipeline, déployé sur Vercel
- Cron : GitHub Actions (scheduled job à 3h07 UTC = 5h07 CET)

## Architecture du pipeline (exécuté chaque matin)

### Étape 1 : Scraping RSS
- Fetch les flux RSS de ~50 sources françaises (nationale, régionale, spécialisée)
- Extraire : titre, description, url, date de publication, source
- Ne garder que les articles des dernières 24h
- Dédupliquer par URL
- Stocker dans Supabase table `articles`

Sources organisées par catégorie et orientation politique :
- **Nationale** : Le Monde (centre-gauche), Le Figaro (droite), Libération (gauche), 20 Minutes (centre), La Croix (centre), L'Humanité (gauche)
- **Info continue** : France Info (service public), BFM TV (centre-droit), France 24 (service public), RFI (service public), Europe 1 (droite)
- **Magazines** : L'Express (centre-droit), L'Obs (centre-gauche), Courrier International (centre), Valeurs Actuelles (droite), Marianne (gauche souverainiste)
- **Économie** : La Tribune (centre), Challenges (centre-droit)
- **Tech** : Numerama, Next, Futura Sciences
- **Environnement/investigation** : Reporterre (gauche), Mediapart (gauche), Basta! (gauche), Alternatives Économiques (centre-gauche)
- **Régionale** : Ouest-France, Sud Ouest, La Dépêche, La Voix du Nord, Midi Libre, Le Télégramme, etc.
- **International** : Huffington Post FR (centre-gauche), Slate FR (centre)

### Étape 2 : Déduplication (3 passes)
- **Passe 1** : regroupement par similarité de titre (Haiku, par batch de 100)
- **Passe 2** : fusion des clusters qui couvrent le même sujet (ex: "municipales Lyon" + "municipales Paris" = "municipales 2026")
- **Passe 3** : vérification finale de doublons sur les noms fusionnés
- Règle anti-fourre-tout : chaque cluster = un événement précis, pas une catégorie

### Étape 3 : Scoring multi-signal
Score final = couverture (35%) + diversité politique (25%) + LLM (30%) + fraîcheur (10%)

- **Signal A — Couverture (35%)** : nombre de sources distinctes qui couvrent l'événement. 8+ sources = score max.
- **Signal B — Diversité politique (25%)** : combien d'orientations (gauche/centre/droite) couvrent le sujet. Si les 3 en parlent = score max. Service public et presse régionale sont neutres.
- **Signal C — Score LLM (30%)** : pertinence évaluée par Haiku (magnitude, échelle, potentiel). Appliqué uniquement aux clusters avec 3+ sources.
- **Signal D — Fraîcheur (10%)** : vitesse de reprise. Toutes les sources en 3h = breaking news = bonus.

### Étape 4 : Récap + baromètre + film
- Récap éditorial de 400-600 mots via Haiku, ton "pote cultivé au café"
- Annotations contextuelles `[[explication]]` transformées en tooltips
- Baromètre du jour (mood 0-100 + emoji)
- Film du jour en lien thématique avec l'actu
- Tout est caché dans `daily_digests` pour éviter de re-générer en dev

### Étape 5 : Génération du site statique
- Design ASCII/terminal (Courier New, monospace)
- Structure : logo ASCII → présentation → date + baromètre → récap → "pourquoi ces sujets" → angles morts → film → sources
- Section "pourquoi ces sujets" : barres ASCII de couverture, diversité politique (■/□), score, liste des sources
- Section "angles morts" : sujets couverts par un seul camp politique (strict : 3+ sources d'un côté, 0 de l'autre)
- Page par jour dans `dist/[date].html`
- Flux RSS `dist/feed.xml`

### Étape 6 : Déploiement
- GitHub Actions cron à 3h07 UTC (5h07 CET)
- Le workflow : checkout → npm ci → build → pipeline → git add dist/ → commit → push
- Vercel redéploie automatiquement à chaque push sur main
- Secrets GitHub : SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY

## Structure de la base Supabase

Table `sources` :
- id (uuid, PK, default gen_random_uuid())
- name (text, not null)
- rss_url (text, not null)
- orientation (text, default 'centre') — gauche, centre-gauche, centre, centre-droit, droite, service public, specialise, regionale
- category (text, default 'nationale') — nationale, info continue, magazine, economie, tech, environnement, investigation, regionale, internationale
- active (boolean, default true)
- created_at (timestamptz, default now())

Table `articles` :
- id (uuid, PK, default gen_random_uuid())
- source_id (uuid, FK -> sources.id)
- title (text, not null)
- description (text)
- url (text, unique, not null)
- published_at (timestamptz)
- score (decimal, nullable)
- summary (text, nullable)
- cluster_id (text, nullable)
- newsletter_date (date, nullable)
- created_at (timestamptz, default now())

Table `daily_digests` :
- id (uuid, PK, default gen_random_uuid())
- date (date, unique, not null)
- article_ids (jsonb) — contient : { clusters, recaps, barometer, film }
- generated_at (timestamptz, default now())

## Structure du repo

```
5h07/
  .github/
    workflows/
      daily.yml         # Cron GitHub Actions à 5h07 CET
  src/
    scraper.ts          # Fetch RSS et stockage
    scorer.ts           # Scoring multi-signal
    dedup.ts            # Déduplication 3 passes
    summarizer.ts       # Récap + baromètre + film
    generator.ts        # Génération HTML statique ASCII
    pipeline.ts         # Orchestre tout dans l'ordre
    db.ts               # Client Supabase
    config.ts           # Variables d'env
  dist/                 # Site statique généré
    index.html
    [date].html
    feed.xml
  setup.sql             # Schéma Supabase + seed sources
  package.json
  tsconfig.json
  .env.example
  CLAUDE.md
```

## Variables d'environnement (.env.example)
```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
ANTHROPIC_API_KEY=
```

## Contraintes
- Tout en TypeScript strict
- Gestion d'erreurs robuste : un flux RSS qui fail ne bloque pas le pipeline
- Logs clairs à chaque étape avec timestamps
- Le coût LLM doit rester sous 10$/mois (le scoring LLM ne cible que les clusters avec 3+ sources)
- Le HTML généré doit être lisible sans JS (tooltips = progressive enhancement)
- Responsive (mobile first, monospace lisible sur mobile)
