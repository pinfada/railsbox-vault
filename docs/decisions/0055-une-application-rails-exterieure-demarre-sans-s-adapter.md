# ADR 0055 — Une application Rails extérieure démarre sans s'adapter à l'outil

- Statut : proposé
- Date : 2026-11-28
- Issue : [#351](https://github.com/pinfada/railsbox-vault/issues/351) · lot
  `lot:applications-tierces` · exigence du mainteneur :
  [#272](https://github.com/pinfada/railsbox-vault/issues/272)
- **Amende** l'[ADR 0041](0041-le-paquet-applicatif-partition-2-d-un-hda-compose.md) (le
  `secret_key_base` ne se dérive plus d'une chaîne publique ; `credentials.yml.enc` sans sa clé est
  exclu, non refusé ; une application sans migration est empaquetable) et
  l'[ADR 0042](0042-le-dephasage-de-versions-le-schema-decide-avant-le-boot.md) (le schéma `0`).
- Reprend : `pinfada/railsbox`, `tools/build-v86-image/base/app.Dockerfile`
  (`bundle lock --add-platform`, valeur jetable à la construction, CR du shebang), `base/Dockerfile`
  (`SECRET_KEY_BASE` fourni par l'outil), et son attente d'une réponse HTTP.

## Contexte

Le 28/11/2026, une application Rails réelle (SQLite, Ruby 3.3, Rails 8.0) a été passée dans
`npm run app:paquet` puis ouverte dans la coquille. Elle n'a jamais démarré. Toutes les épreuves
tournaient sur `apps/reference`, qui connaît Vault. L'issue relève cinq blocages et deux défauts ;
l'épreuve rouge, jouée sur une application `rails new` non modifiée, en a trouvé quatre de plus :

| Blocage                                                       | Où                                       |
| ------------------------------------------------------------- | ---------------------------------------- |
| `config/credentials.yml.enc` refusé                           | examen de la source                      |
| aucune migration : « Schéma introuvable »                     | examen de la source (épreuve rouge)      |
| verrou `x86_64-linux` seul : `bundle install` échoue en i386  | `guest.Dockerfile`, étage `disque-app`   |
| la garde de secrets refuse les `.pem` des gemmes installées   | `guest.Dockerfile` (épreuve rouge)       |
| `Missing secret_key_base` dès `db:migrate`, à la construction | `guest.Dockerfile` (épreuve rouge)       |
| CRLF : `/usr/bin/env: 'ruby\r'`                               | guest                                    |
| `Missing secret_key_base` au démarrage                        | guest                                    |
| la coquille attend `/vault/health` en 200 JSON                | `reference-guest-session.mjs`            |
| `/vault/invariant` en 404 HTML : `JSON.parse` lève            | `boot-de-reference.mjs` (épreuve rouge)  |
| schéma `2026_08_18_213000` lu « 2026 » ; `servie.id: null`    | `schema-de-l-application.mjs`, déphasage |
| un échec dit « sans cause identifiée » après cinq minutes     | coquille                                 |

Chacun obligeait l'APPLICATION à s'adapter à l'outil. La règle est l'inverse : rien de spécifique à
une application, aucune route, aucun fichier, aucune configuration ajoutés à l'application.

## Décision

### 1. Prêt = Rails répond (`src/vm/sonde-de-demarrage.mjs`)

Toute réponse HTTP vaut « prêt ». Le pont série rend une ERREUR quand rien n'écoute, et Puma en mode
simple charge l'application avant d'ouvrir son port : une réponse, quel que soit son statut, dit que
Rails est chargé. Le chemin sondé reste `/vault/health` : une application qui ne le porte pas y rend
sa 404 sans contrôleur, la requête la moins coûteuse qu'on puisse lui faire ; la référence y rend sa
santé, lue quand elle est là (`sante`, `null` sinon). L'invariant reste un contrat de la référence,
lu à part : une réponse qui n'est pas du JSON donne un verdict `null` et son statut est publié.

### 2. Un échec dit sa cause, en clair, et tout de suite

`guest-init.sh` écrit `[vault] application arretee (code N)` dans le journal de l'application quand
elle s'arrête ; le pont le relaie, et la sonde échoue sans attendre le délai. La cause rassemble ce
qui manque (clé secrète, fins de ligne, gemme, base), la dernière erreur de la sonde et la dernière
ligne de l'application, sans caractère de contrôle, bornée à 600 caractères. Elle voyage sous un
code nouveau, `VAULT_COQUILLE_APPLICATION_EN_ECHEC`, que la page dit avec sa conduite. Ce n'est plus
une « installation inachevée » : le versement a abouti, le guest a battu.

### 3. Le `secret_key_base` est fourni par le coffre

RailsBox le tire au hasard à la construction de son image. L'image de Vault est publique : une
valeur cuite y serait connue de tout visiteur. `secret-du-coffre.sh` la tire donc au PREMIER BOOT,
dans le guest, la garde sur le disque de données (`/app/var/.vault-secret-key-base`, mode `600`) et
`guest-init.sh` l'exporte avant la migration et Puma. Propre au coffre, stable d'un boot à froid à
l'autre, jamais publiée. Portée et limites : `SECURITY.md`. La construction emploie le geste que
Rails prévoit pour elle, `SECRET_KEY_BASE_DUMMY`, retiré de l'image avant sa publication.

### 4. La plateforme `ruby` est ajoutée au verrou, dans la copie

`BUNDLE_FROZEN=false bundle lock --add-platform ruby` avant `bundle install`, puis le verrou
augmenté remis après `COPY . ./`. RailsBox ajoute `x86-linux ruby` ; ici `ruby` suffit, parce que
`BUNDLE_FORCE_RUBY_PLATFORM` compile chaque gemme depuis ses sources, et la référence tourne sous un
verrou qui ne porte que `ruby`. Ajouter `x86-linux` réécrirait sans besoin le verrou de la
référence.

### 5. Les fins de ligne sont normalisées dans l'arbre du paquet

Tout fichier texte (aucun octet nul dans ses 8 Kio de tête, le critère de git) passe de CRLF à LF
dans la copie ; les binaires sont recopiés à l'octet, la source n'est jamais écrite. RailsBox ne
retire le CR que de la première ligne d'un fichier à shebang : c'est le cas qui casse à coup sûr,
mais pas le seul.

### 6. `credentials.yml.enc` sans sa clé est exclu, et c'est dit

Sans `master.key`, il ne contient rien d'utilisable. Il est exclu, la fabrication l'imprime, et les
paires par environnement suivent la même règle. Une clé présente reste refusée, comme avant. La
garde de secrets du Dockerfile écarte `vendor/bundle`, écrit par `bundle install` depuis
rubygems.org et non par la source : ses certificats publics et ses clés de test refusaient toute
application qui dépend de Kamal ou de Capybara.

### 7. Le schéma

Les littéraux à soulignés de `schema.rb` sont lus en entier. Une application sans migration a le
schéma `0`, celui qu'ActiveRecord donne à une base dont `schema_migrations` est vide ; la première
migration d'une version suivante le fait avancer par le chemin de l'ADR 0042. À l'installation, le
déphasage porte aussi l'identité servie (`servie.id`).

### 8. Les données d'une application ordinaire vivent sur le disque de données, et durablement

`storage` devient, dans le PAQUET, un lien vers `var/storage`, posé avant `db:migrate` : les bases
de `config/database.yml` (production, `cache`, `queue`, `cable`) et ActiveStorage `Disk` naissent
dans la graine. Un lien de RÉPERTOIRE, et non une `DATABASE_URL` : RailsBox pose
`DATABASE_URL=sqlite3:storage/production.sqlite3`, qui ne couvre que la base primaire et laisse les
journaux là où le lien ne les suit pas. Un lien par base ferait naître le journal de SQLite à côté
du lien, donc dans `/app`.

`durabilite-rails.rb`, chargé par `RUBYOPT`, pose `synchronous = EXTRA` sur chaque connexion SQLite
et synchronise ActiveStorage `Disk` après chaque téléversement — ce que la référence fait par son
`database.yml` et son `DurableDiskService`. `verifier-durabilite.rb` le CONSTATE à la fabrication et
la refuse sinon. Les limites de ce mécanisme sont dans `SECURITY.md`.

## Ce qui est écarté

- **Une route de santé injectée dans l'application** (middleware, initialiseur) : c'est ajouter du
  code à l'application.
- **Un `secret_key_base` cuit dans l'image**, à la manière de RailsBox : l'image est publique.
- **Dériver la valeur de la clé du volume côté coquille et la passer par la ligne de commande du
  noyau** : la ligne de commande est relue par le manifeste et les épreuves, et la clé ne doit
  jamais sortir de la frontière de la coquille sous une forme dérivable.

## Limites, mesurées ou non

- Prouvé par `tests/e2e/application-exterieure.spec.mjs` (lot 6 de `reprise.yml`) sur une
  application `rails new` augmentée d'un scaffold : la fabrication, le démarrage sous Chromium, une
  réponse de Rails, une note écrite par le formulaire et relue après verrouillage, instantané écarté
  et boot à froid.
- Les bases `cache`, `queue` et `cable` de Rails 8 naissent vides : la fabrication joue
  `db:migrate`, et non `db:prepare`, qui chargerait leurs `*_schema.rb`. Une application qui s'en
  sert au premier rendu échouerait ; le scaffold n'en dépend pas.
- Les groupes `development` et `test` du Gemfile sont installés : `BUNDLE_WITHOUT` n'est pas posé,
  il changerait aussi le bundle de la référence.
- `active_record_encryption` et les credentials métier restent absents.
