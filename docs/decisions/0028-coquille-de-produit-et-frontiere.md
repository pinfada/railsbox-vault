# ADR 0028 — La coquille de produit et sa frontière

- Statut : accepté
- Date : 2026-09-07
- Issue : #161 (tranche 1 de #24) · Invariant : `SEC-ORIGIN-001` · Jalon 5
- **Donne sa première décision** à quatre des six interfaces que
  l'[ADR 0002](0002-topologie-origine-de-confiance.md) § « Interfaces à ne pas figer avant #24 »
  avait réservées ; les deux autres restent réservées, et cet ADR dit laquelle à qui. Rien de l'ADR
  0002 n'est réécrit.

## Contexte

La frontière était **décidée** depuis l'ADR 0002 — document applicatif sur une origine distincte,
`sandbox="allow-scripts allow-same-origin"`, `MessagePort` transféré, liste d'admission — et elle
était **éprouvée** : `SEC-ORIGIN-001` figurait « exercé » dans `SECURITY.md`, sur quatre topologies,
trois moteurs, avec témoin positif. Ce que #24 a établi en la raffinant est pourtant net : la
coquille de PRODUIT n'existait pas.

Le relevé, fichier par fichier, ne laissait pas de place au doute. `public/index.html` faisait
quinze lignes — un titre, un `<h1>`, un `<p>`. `public/main.mjs` en faisait vingt-huit : il
démarrait un Worker, vérifiait un message et l'arrêtait aussitôt par `worker.terminate()`.
`public/runtime-worker.mjs` en faisait **trois**. Et l'identifiant du contrat disait ce qu'il était
: `railsbox-vault-browser-harness`. Aucune clé, aucun port, aucun cadre applicatif, aucun
déverrouillage.

Ce qui EXISTAIT, en revanche, était un BANC. `public/spike/origin/shell.html` et `shell.mjs` sont la
seule chose du dépôt qui établissait un canal privilégié avant qu'aucun document applicatif
n'existe, encadrait une origine distincte et transférait un port restreint après vérification du
type, de l'origine et de la fenêtre émettrice. Son en-tête l'écrit : « coquille compétente, PAS
durcie ». Elle plante des appâts délibérés (`window.__vaultShellSecretBait`), sa liste d'admission
accepte **un** type de requête, et son « secret » est `SHELL_SECRET`, pas une clé de volume. Les
deux seuls fichiers du dépôt qui portaient les mots « Worker de confiance » —
`public/vm/deverrouillage-worker.mjs` et `public/vm/enveloppe-worker.mjs` — sont eux aussi des
Workers de bancs.

Le statut « exercé » de `SECURITY.md` décrivait donc une coquille que personne n'avait écrite. C'est
le risque principal que l'issue #24 nommait, et cette tranche est sa mitigation.

## Décision 1 — Une coquille NEUVE ; le spike reste vivant et inchangé

`public/index.html` et `public/main.mjs` deviennent la coquille de produit ;
`public/runtime-worker.mjs` devient le Worker de confiance. `public/spike/origin/*` n'est ni modifié
ni promu.

**Ce qui départage** : `tests/browser/origin-topology.spec.mjs` est à la fois la preuve de
`SEC-ORIGIN-001` et son témoin positif sur la topologie la plus permissive. Promouvoir la page du
spike l'aurait fait disparaître comme témoin — et un relevé sans témoin ne prouve rien.

**Ce qui est REPRIS du banc** : la structure, et elle seule. Canal privilégié établi avant tout
document applicatif ; port restreint transféré une fois ; vérification de l'annonce sur trois
critères indépendants ; sonde qui n'affirme rien d'elle-même et laisse l'épreuve juger.

**Ce qui est DÉRIVÉ, et donc pas repris** : les six interfaces que l'ADR 0002 réserve. La liste est
une liste d'écueils, pas une base de départ ; leur état après cette tranche est au § « Impacts ».

**Le contrat a une identité de produit et une version** (`src/coquille/contrat-de-messages.mjs`) :
`railsbox-vault-coquille`, version 1. Son encodage est refusé **strictement** — un message qui n'est
pas un objet, qui porte un autre identifiant de contrat, une autre version, ou pas de type, reçoit
un code. L'ordre des quatre contrôles compte : un objet venu d'un autre logiciel ne doit pas
recevoir un diagnostic de version, qui lui apprendrait quelque chose de nous sans rien nous
apprendre de lui.

Deux canaux, deux vocabulaires : aucun type du canal privilégié n'est un type du port restreint, et
réciproquement. Un type privilégié posé sur le port de l'application est refusé **nommément** —
`VAULT_COQUILLE_PORT_PRIVILEGIE_REFUSE` — parce que c'est exactement ce que la tentative est.

**Une garde qui manquait au banc** : la coquille refuse de s'exécuter **encadrée**.
`frame-ancestors 'none'` le dit déjà au navigateur, et c'est la vraie défense ; celle-ci existe pour
le cas où la coquille serait servie sans sa CSP — par un hébergeur qui ignore `_headers`, ou par le
rôle `app` du serveur de test, qui n'en sert aucune. Sans elle, une coquille encadrée par elle-même
créerait un cadre, qui créerait une coquille, indéfiniment.

## Décision 2 — Le port restreint : admission DÉRIVÉE, refus non négociable

### Ce que le relevé a trouvé

L'ADR 0002 exige que la liste d'admission soit « dérivée des besoins réels de l'application, pas
devinée ». Le relevé part d'un fait gênant : `apps/reference` est une application
`ActionController::API` de **deux routes JSON**, sans session, sans cookie, sans gabarit et **sans
une ligne de JavaScript**. Elle ne demande donc rien à la coquille par elle-même. Ce qui a été
dérivé, ce sont les gestes dont les SCÉNARIOS ont besoin pour qu'un document encadré serve à quelque
chose.

**Deux gestes admis**, chacun cité à la ligne dans `src/coquille/admission-applicative.mjs` et relu
par `tests/unit/coquille-admission.test.mjs`. La forme du renvoi est celle de la spécification —
`chemin:ligne › « fragment »` —, et c'est le FRAGMENT qui ancre : la première rédaction n'exigeait
que l'existence de la LIGNE, et la revue de la PR #166 a relevé (constat 8) qu'un numéro qui existe
ne prouve rien, un fichier qui grandit de dix lignes déplaçant tout sans rien invalider en
apparence.

| Geste admis                                                   | Sens                             | Usage qui le demande                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault.coquille.etat` — état du volume et compte de barrières | application → coquille           | `public/vm/reference-worker-phases-volume.mjs:277` › « `present: etat.present,` » (la seule observation qu'un scénario fait d'un volume avant de s'en servir), `tests/e2e/instantane-reprise.spec.mjs:201` › « `phase: "inspect-volume"` », `src/spike/origin-topology.mjs:118` › « `export function isAllowedAppRequest` » |
| `vault.coquille.barriere` — annonce d'une barrière acquittée  | coquille → application (POUSSÉE) | `public/vm/reference-banc.mjs:73` › « `if (type === "mutation")` » (l'annonce existe déjà, et ne porte aucun identifiant de requête : c'est une poussée), `tests/e2e/coupure-generation-boot-froid.spec.mjs:159` › « une barrière a été acquittée »                                                                         |

La réponse d'état ne porte QUE deux champs : l'état — `demarrage`, `verrouille`, `ouvert`,
`indisponible` — et un COMPTE de barrières. Un compte, et non un horodatage : il est monotone, ne
dépend d'aucune horloge, et suffit à ce que l'application dise « enregistré ». Un horodatage aurait
ajouté une horloge de l'origine de confiance à ce qui franchit la frontière, pour rien.
`indisponible` est distinct de `verrouille`, et ce n'est pas cosmétique : l'un dit « il faut un
geste », l'autre « ce moteur ne sait pas », et les confondre ferait redemander à l'utilisateur une
phrase qui n'ouvrirait rien.

### Ce qui a été examiné et ÉCARTÉ

Une liste courte sans trace de ce qu'on a refusé d'y mettre se relit comme un oubli. Trois candidats
ont été écartés, et le code les nomme (`GESTES_ECARTES`) :

- **la taille du volume ou l'espace restant.** Aucun usage ne le demande. Ni `apps/reference` ni un
  scénario de `tests/e2e/` ne consulte l'espace ; la couche budget (#9) est un geste de la COQUILLE,
  mesuré page-side, et l'ADR 0006 fait de la conduite au refus une affaire de la coquille.
  L'application apprend le manque par l'échec de sa propre écriture — et un chiffre d'espace est un
  canal auxiliaire gratuit ;
- **un identifiant d'application.** L'ADR 0018 § 4 décide que l'origine EST l'identité et interdit
  d'inventer ce champ. `tests/unit/coquille-admission.test.mjs` balaie la source des modules de la
  coquille pour qu'il ne réapparaisse pas ;
- **la version d'enveloppe, demandée ou fournie.** L'ADR 0027 décision 3 tranche qu'elle est une
  SAISIE de l'utilisateur dans la coquille ; une version fournie par l'origine applicative
  rouvrirait le déni de service écarté par écrit.

### La liste de refus, et pourquoi chaque geste a SON code

Dix gestes, dix codes (`VAULT_COQUILLE_*`, spécification § 10.5). Un refus générique les aurait tous
couverts, et c'est précisément ce qui l'aurait rendu inutile : l'épreuve de l'application
malveillante n'aurait plus pu distinguer « la coquille refuse ce geste-là » de « la coquille n'a pas
compris le message », et un relevé tout vert se serait obtenu par incompréhension.

Ce n'est pas un oracle. Le code rendu ne dépend QUE du type reçu : il est calculé avant que la
coquille ait consulté un état, et deux appareils dans des états différents rendent le même code pour
le même type. `evaluerRequete` ne prend aucun état en argument, et l'épreuve le vérifie sur son
arité.

Le port ne transporte **jamais** de handle, de clé, de descripteur ni de capacité transférable :
`sansCapacite` refuse récursivement seize constructeurs et toute vue sur un tampon, et il est appelé
à l'enveloppe de chaque message. Le refus est une exception, pas un refus poli : ce serait un défaut
de programmation de la coquille, pas une entrée hostile.

### L'annonce, et l'ORDRE

Cinq conditions, contrôlées dans cet ordre :

1. **le canal privilégié existe.** Il vient en premier parce qu'il ne dépend pas du candidat : une
   coquille qui octroierait un port avant d'avoir son canal promettrait un service qu'elle ne peut
   pas rendre. L'issue #24 pose cet ordre comme non négociable ;
2. **le type**, qui ne prouve rien seul puisque n'importe quel document le connaît ;
3. **l'origine**, qui sépare la topologie retenue de la topologie en même origine ;
4. **la fenêtre émettrice**, seule à distinguer le cadre d'une iframe imbriquée qu'il aurait créée —
   laquelle porte exactement la même origine ;
5. **l'unicité**, en dernier : un second appel bien formé doit être refusé POUR CE MOTIF, et l'ordre
   inverse ferait rendre « origine inattendue » à un second cadre légitime.

L'origine attendue n'est jamais lue d'un message — « une origine annoncée par celui qu'on vérifie ne
vérifie rien » — ni d'un stockage, ni de l'URL. Elle est DÉRIVÉE de l'origine de la coquille
(`src/coquille/origines-de-la-coquille.mjs`) : hôte préfixé de `app.` sur un domaine propre, schéma
de l'ADR 0002 et de l'ADR 0018 ; et, par exception déclarée, le couple local `127.0.0.1` /
`localhost` sur le port suivant, que le dépôt emploie depuis le spike #35. Une origine que ni la
règle ni l'exception ne savent traduire rend `null` : la coquille n'invente alors aucun cadre.

Le CHEMIN encadré, lui, est un paramètre — en production, ce que la coquille encadre est ce que
l'utilisateur demande à l'application, `/commandes/42` aussi bien que `/`. L'origine ne l'est
jamais, et un chemin qui cesserait d'en être un (`//exemple.test/`, `https://exemple.test/`) est
refusé avant que la CSP ait à s'en mêler : une frontière qui ne tient que par sa seconde ligne de
défense n'est pas une frontière.

## Décision 3 — Aucun cookie, éprouvé comme une propriété

La coquille ne pose aucun cookie. Ce n'est pas une abstention : c'est une propriété mesurée en trois
points par `tests/browser/coquille-frontiere.spec.mjs`, après un cycle complet — bocal du contexte
vide, `document.cookie` vide sur les DEUX origines, et aucune réponse servie ne portant
`Set-Cookie`. La troisième mesure n'est pas redondante : les deux premières diraient « aucun cookie
» même si un cookie `HttpOnly` avait été posé.

Le motif vient de l'ADR 0018 § 5 : sur un domaine propre, les deux origines de l'ADR 0002 sont le
même **site** (ADR 0017 fait 1), et **`SameSite` ne sépare pas deux sous-domaines d'un même site**.
Si un cookie devenait un jour nécessaire, il portera le préfixe `__Host-` — qui interdit l'attribut
`Domain` et impose `Path=/` et `Secure`, seul mécanisme qui rende l'absence de partage vérifiable
côté navigateur plutôt que par relecture — et rien ne sera jamais posé sur le domaine parent.

## Décision 4 — `SEC-ORIGIN-001` porte deux lignes

`SECURITY.md` distingue désormais :

- **coquille du SPIKE — exercé**, preuve `tests/browser/origin-topology.spec.mjs` ;
- **coquille de PRODUIT — exercé sous réserve**, preuve `tests/browser/coquille-frontiere.spec.mjs`
  (application malveillante, dix gestes refusés, témoin positif en même origine, trois moteurs) plus
  les deux suites unitaires.

> **RETIRÉE le 7 septembre 2026 par #162** ([ADR 0029](0029-deverrouillage-dans-la-coquille.md),
> décision 1). Le jeton de harnais a quitté le chemin de produit : `public/main.mjs` ne lit plus de
> paramètre, `public/runtime-worker.mjs` n'appelle plus la porte de `src/vm/cle-de-volume.mjs`, et
> le type `vault.coquille.deverrouiller` porte désormais un MOYEN — phrase, passkey ou code de
> récupération — au lieu d'un jeton. `tests/unit/harnais-portes.test.mjs` exige maintenant **aucun**
> appelant de PRODUIT là où il en tolérait un. Ce qui suit décrit ce qui a été, et le paragraphe sur
> le caractère PUBLIC du jeton reste vrai : ce qui a changé n'est pas sa visibilité, c'est qu'il
> n'ouvre plus aucune porte.

**La réserve, en toutes lettres** : la frontière est éprouvée sur les ports réels, mais le geste de
DÉVERROUILLAGE vient encore du harnais, sous le jeton de `src/vm/cle-de-volume.mjs` — la même porte
que celle de la réserve de `SEC-BLOCK-001`, désormais visible sur le chemin du produit au lieu de ne
l'être que dans les bancs. La tranche 2 (#162) la remplace par la phrase, la passkey et le code de
récupération. Le cycle de vie assemblé reste la tranche 3 (#163).

**Le jeton est PUBLIC, et il faut l'écrire ainsi.** La première rédaction de cet ADR affirmait
qu'aucun fichier publié ne contenait sa valeur. C'était faux, et la revue de sécurité de la
[PR #166](https://github.com/pinfada/railsbox-vault/pull/166) l'a mesuré :
`src/vm/cle-de-volume.mjs` est publié, il DÉFINIT le jeton, et — sans étape de construction — une
constante que le produit compare existe forcément dans le code servi. Pire, l'épreuve censée
l'attester s'excluait elle-même du balayage, et était donc verte par construction.

La correction n'est pas de cacher la valeur : la cacher demanderait un minifieur, c'est-à-dire une
promesse qui dépend d'un outil plutôt que d'une frontière. Ce que le dépôt promet est autre chose,
et c'est plus fort :

- **la valeur ne protège rien.** Elle ouvre la clé de TEST — trente-deux octets publics sans
  entropie —, et un volume scellé sous elle est un banc, pas un coffre ;
- **la connaître ne donne rien depuis l'origine applicative.** Le jeton ne s'emploie que sur le
  canal PRIVILÉGIÉ, qu'aucun message du document applicatif n'atteint. La fixture le LIT chez elle —
  témoin positif — puis le présente sur le port restreint (`VAULT_COQUILLE_PORT_PRIVILEGIE_REFUSE`),
  sur `window` (aucun canal ne l'écoute), et constate qu'elle ne connaît même pas l'URL de la
  coquille où le rejouer en paramètre, `Referrer-Policy: no-referrer` la lui refusant. L'état de la
  coquille ne bouge pas ;
- **un seul fichier publié le porte**, celui qui le définit, et le balayage EXIGE désormais de l'y
  trouver — un témoin de fouille — et rougit sur un second porteur ;
- **la coquille ne fige nulle part la valeur** : elle la LIT d'un paramètre nommé. Un jeton écrit en
  dur dans la page serait un déverrouillage que n'importe quelle visite déclencherait.

`tests/unit/dossier-de-revue.test.mjs` a été élargi en conséquence : un invariant peut porter
plusieurs lignes, mais chacune doit dire CONTRE QUOI il est exercé, faute de quoi deux statuts
contradictoires vaudraient pour la même chose.

## Modèle de menace

**Ce que la coquille défend** : le code applicatif hostile servi par Rails, avec ses dépendances,
son hébergement et son relais (ADR 0002, ADR 0018).

**Ce qu'elle ne défend pas**, écrit au même niveau : une publication compromise de la coquille
elle-même (`SEC-UPDATE-001`, #45) ; un navigateur ou une extension compromis ; l'adversaire qui
ÉCRIT dans l'OPFS de l'origine de confiance — celui de l'ADR 0019 § 6.9, qui peut déjà détruire le
volume, et que la limite 7 de l'ADR 0027 retrouve avec la page d'archive installée à la place de la
page vivante (un DÉNI, pas une exposition) ; l'épaule qui lit le code de récupération à l'écran ; et
deux applications partageant l'origine applicative, mesuré par #46 et accepté tant qu'une seule
application est publiée.

**Le TEMPS de la coquille, et pas sa mémoire.** La revue de la PR #166 a ajouté cette ligne au
modèle de menace, qui ne la nommait ni d'un côté ni de l'autre. Un document applicatif hostile peut
poster autant de messages qu'il veut, et chacun est décodé et compté : le fil d'exécution que la
coquille partage avec lui n'est pas défendu, et ne peut pas l'être — un document encadré occupe de
toute façon le processus qui l'héberge. Ce que la coquille borne, c'est sa MÉMOIRE, et cette
moitié-là est fermée : le relevé ne recopie rien du guest (des compteurs par code, et l'ensemble des
codes est clos), la file d'appariement a une borne nommée, un `type` au-delà de 128 caractères est
refusé au décodage. La version d'avant ne bornait rien : quarante messages faisaient passer le
relevé de 606 à 8 003 678 caractères, et le relevé entier était re-sérialisé à chaque refus — un
déni de service de la base de confiance, commandé depuis exactement l'adversaire que cet ADR dit
défendre. L'épreuve pousse désormais mille messages et exige que le relevé reste sous deux
kilo-octets, sur les trois moteurs.

## Les épreuves, et leurs témoins

L'application malveillante (`public/coquille-epreuve/`) est servie **par l'origine applicative**,
encadrée par la coquille comme le serait du HTML rendu par Rails. Elle connaît le contrat aussi bien
que la coquille : elle s'annonce en règle, obtient son port, puis exécute **trente-huit sondes** —
le geste admis et quatre requêtes CONCURRENTES, les dix gestes interdits, quatre tentatives autour
du jeton du harnais, neuf contre l'encodage et le canal privilégié, un second port réclamé, une
iframe imbriquée usurpatrice, et dix tentatives de topologie. Elle enregistre en outre TOUT ce qui
franchit le port, dans les deux sens, pour que l'épreuve le FOUILLE. Elle n'est jamais publiée :
`tools/publier-arborescences.mjs` la retire avec son motif.

Le témoin positif vient en deux moitiés, parce que les deux familles ne se prouvent pas de la même
façon :

- **le contrat** : la même fixture, sur le même port, OBTIENT le geste admis. Un port cassé aurait
  tout refusé, y compris ce qu'il doit servir ;
- **la topologie** : la MÊME fixture, servie par l'origine de CONFIANCE, obtient ce qu'on lui refuse
  ailleurs — le volume et son enveloppe dans l'OPFS, le DOM, la fenêtre auxiliaire, la portée d'un
  Service Worker et l'interception de la ressource témoin. La contamination est arbitrée **depuis la
  coquille**, qui seule sait de quelle partition il s'agit ;
- **la fouille** : le trafic du port est cherché à la recherche des octets RÉELS que le Worker
  détient — la clé de volume de TEST et les trois clés de déverrouillage, en hexadécimal et en
  base 64. La recherche doit d'abord montrer qu'elle sait trouver ce qui EST là, faute de quoi «
  rien trouvé » voudrait dire « rien capturé ». `sansCapacite` ne suffisait pas à porter cette
  garantie : il refuse des CONSTRUCTEURS, pas des secrets, et laisserait passer une clé rendue en
  hexadécimal, qui est une donnée. C'est le constat 5 de la revue de la PR #166.

**Deux sondes n'ont PAS de témoin positif contre cette coquille, et il faut le dire** : le verrou
nommé et la diffusion inter-onglets n'existent pas encore dans le produit — la coquille ne prend
aucun `navigator.locks` nommé et n'ouvre aucun `BroadcastChannel`. Leur témoin reste celui du spike,
en topologie T1a. C'est une des raisons pour lesquelles ce banc doit rester vivant.

## Campagne de mutation

Vingt-trois gardes, chacune retirée du source dans un atelier temporaire, l'épreuve rejouée
(`tools/muter-gardes-coquille.mjs`, moteur partagé). Les huit dernières viennent de la revue de la
PR #166 : trois gardes existantes étaient hors campagne (constat 10), et cinq sont neuves.

| #   | Garde retirée                                                       | Verdict |
| --- | ------------------------------------------------------------------- | ------- |
| 1   | `evaluerAnnonce` — la condition d'ORDRE, contrôlée la première      | TUÉ     |
| 2   | `evaluerAnnonce` — la vérification du type                          | TUÉ     |
| 3   | `evaluerAnnonce` — la vérification de l'origine                     | TUÉ     |
| 4   | `evaluerAnnonce` — la vérification de la fenêtre émettrice          | TUÉ     |
| 5   | `evaluerAnnonce` — l'unicité                                        | TUÉ     |
| 6   | `evaluerRequete` — la consultation de la liste de refus             | TUÉ     |
| 7   | `evaluerRequete` — la reconnaissance des types privilégiés          | TUÉ     |
| 8   | `evaluerRequete` — le filtre de la liste d'admission                | TUÉ     |
| 9   | `decoderMessage` — la comparaison de l'identifiant de contrat       | TUÉ     |
| 10  | `decoderMessage` — la comparaison de version                        | TUÉ     |
| 11  | `sansCapacite` — les constructeurs interdits et les vues sur tampon | TUÉ     |
| 12  | `enveloppeDeMessage` — l'appel à `sansCapacite`                     | TUÉ     |
| 13  | `cheminApplicatifAdmis` — le refus de `//`                          | TUÉ     |
| 14  | `origineApplicativeDe` — le refus d'un hôte déjà préfixé            | TUÉ     |
| 15  | `chargeUtileDEtat` — la table des états connus                      | TUÉ     |
| 16  | `cheminApplicatifAdmis` — l'exigence d'une barre oblique initiale   | TUÉ     |
| 17  | `cheminApplicatifAdmis` — le refus de la barre oblique inversée     | TUÉ     |
| 18  | `decoderMessage` — la nature du type                                | TUÉ     |
| 19  | `decoderMessage` — la borne de longueur du type                     | TUÉ     |
| 20  | `evaluerRequete` — le contrôle de forme exacte                      | TUÉ     |
| 21  | `evaluerRequete` — l'exigence d'un identifiant de corrélation       | TUÉ     |
| 22  | `correlationAdmise` — l'alphabet et la longueur                     | TUÉ     |
| 23  | `typeRendu` — la borne de ce qui repart                             | TUÉ     |

**23/23.** Deux mutants ont SURVÉCU avant d'être tués, et c'est le service que la campagne rend :

- le n° 9 — retirer la comparaison d'identifiant de contrat laissait le refus tomber sur la
  comparaison de VERSION, sous le même code, si bien que l'épreuve — qui confrontait un contrat
  étranger portant une version étrangère — restait verte. Elle confronte désormais un contrat
  étranger portant LA nôtre ;
- le n° 17 — tous les chemins refusés de l'épreuve tombaient sur l'exigence de la barre oblique
  INITIALE, jamais sur le refus de la barre inversée. Il a fallu un cas qui commence bien par `/` et
  contienne une barre inversée pour que la garde soit mesurée.

Dans les deux cas la garde n'avait pas changé : c'est l'épreuve qui ne la mesurait pas.

**Ce que la campagne ne peut PAS mesurer** : ce que le NAVIGATEUR fait de ces décisions — que
`postMessage` transfère réellement un port, que la sandbox refuse réellement la navigation du
sommet, que l'OPFS soit réellement partitionné. Cela relève des épreuves navigateur, sur les trois
moteurs. Les deux se complètent : la campagne dit que la décision sait rougir, le navigateur dit
qu'elle porte sur quelque chose.

## Mesures

Ce que l'assemblage coûte, en millisecondes depuis l'évaluation du module de la coquille. Cinq
exécutions par moteur, sur l'exécutant de développement (Windows 11, machine de bureau) ; la
médiane, puis le minimum et le maximum. Le relevé est publié par la coquille elle-même
(`#coquille-rapport`, champ `mesures`) et attaché par `tests/browser/coquille-frontiere.spec.mjs` ›
« l'assemblage publie ce qu'il COÛTE : canal privilégié, puis cadre applicatif ». **Aucun seuil
n'est posé** : un seuil sur un exécutant partagé mesurerait la machine.

| Moteur   | Canal privilégié établi | Déverrouillage (harnais) achevé | Cadre applicatif chargé  |
| -------- | ----------------------- | ------------------------------- | ------------------------ |
| Chromium | 100 ms (96 – 155)       | 271 ms (266 – 336)              | 318 ms (307 – 368)       |
| Firefox  | 345 ms (305 – 381)      | 964 ms (660 – 1 392)            | 3 879 ms (3 068 – 4 563) |
| WebKit   | 560 ms (268 – 677)      | 597 ms (278 – 700)              | 761 ms (371 – 887)       |

Trois lectures, et une seule est une surprise :

- **le canal privilégié est bon marché partout** : de 100 ms à 560 ms pour créer le Worker de
  confiance, transférer le port et faire un aller-retour. L'ordre non négociable de #24 ne coûte
  donc rien à défendre ;
- **le déverrouillage est publié à part**, parce qu'il ne relève pas de la coquille : c'est le prix
  de l'enveloppe, de l'OPFS et du moteur, déjà mesuré par les ADR 0021 et 0025. Le confondre avec le
  coût du cadre ferait porter à l'assemblage une attente qui n'est pas la sienne ;
- **Firefox met ~2,9 s de plus que les autres à charger le cadre inter-origine**, une fois le
  déverrouillage retranché. Ce n'est pas le prix de la frontière — c'est celui de l'iframe
  inter-origine chez ce moteur, dans nos conditions. C'est un travail d'INTERFACE, exactement comme
  l'attente de dérivation de l'ADR 0021 : **annoncer l'attente plutôt que prétendre l'abaisser**. La
  tranche 2 en hérite.

## Limites

- **le déverrouillage n'est pas encore dans la coquille.** Le geste vient du harnais, sous jeton.
  C'est la réserve écrite de `SEC-ORIGIN-001` côté produit, et le travail de la tranche 2 (#162) ;
- **le cycle de vie n'est pas assemblé.** Les huit étapes de `docs/architecture.md` restent des
  bancs, sauf l'étape 2 (canal privilégié) qui est désormais du produit. La tranche 3 (#163) les
  assemble, et tranche COOP ;
- **aucun scénario de `tests/e2e/` n'a été déplacé sur la coquille réelle.** Il reste sur
  `/vm/reference.html`. C'est le critère de fermeture de la tranche 3, pas de celle-ci ;
- **en production, l'origine applicative ne sert encore qu'une place tenante** qui n'annonce rien.
  Le document loyal du dépôt (`public/document-applicatif.html`) est une surface de DÉVELOPPEMENT,
  exclue de la publication : l'ADR 0002 refuse un artefact de ce dépôt sur le territoire du guest,
  et un document applicatif sur l'origine de confiance ;
- **rien n'est mesuré chez un hébergeur réel.** Les en-têtes servis ici le sont par
  `tools/serve.mjs` ; #124–#126 mesurent l'effet chez un hébergeur ;
- **COOP n'est pas servi**, et l'admissibilité d'un Service Worker dans la frontière n'est pas
  tranchée : l'ADR 0010 la réserve à la tranche 3.

## Impacts

### Sur l'ADR 0002 — les six interfaces réservées, une par une

| Interface réservée par l'ADR 0002                                  | État après #161                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| la forme des messages et leur sérialisation                        | **décidée** — `src/coquille/contrat-de-messages.mjs`, identifiant de produit, version 1, encodage refusé strictement     |
| la liste d'admission des requêtes applicatives                     | **décidée** — deux gestes, dérivés et cités ; trois candidats écartés par écrit                                          |
| le protocole d'établissement du canal privilégié coquille ↔ Worker | **décidé pour son ORDRE et son établissement** ; ce qu'il transportera du runtime v86 reste ouvert, et suit la tranche 3 |
| la stratégie de reprise après perte du cadre ou du Worker          | **RESTE RÉSERVÉE** — l'issue #24 la tranche AVEC #25, à l'ouverture de la tranche 3                                      |
| l'allocation des cookies et du bocal de session                    | **décidée** — aucun cookie, éprouvé (décision 3)                                                                         |
| la géométrie du backend OPFS et ses codes d'erreur                 | **RESTE CELLE DE #6** — les ADR 0003 et 0016 l'ont décidée ; #161 n'y touche pas et se contente de l'employer            |

Le risque résiduel 2 de l'ADR 0002 — « le port restreint reste une capacité » — est tenu par
`sansCapacite` plutôt que par une convention de relecture, et la mutation n° 11 montre que la garde
sait rougir.

### Sur l'ADR 0018

La décision 4 (« l'origine EST l'identité ») est appliquée : aucun champ du contrat ne nomme une
application, et une épreuve balaie la source des modules de la coquille pour qu'il ne réapparaisse
pas. La décision 5 (les trois contraintes de cookies) est **résolue** par la décision 3 ci-dessus.

### Sur le gate « données sensibles » de `SECURITY.md`

#24 devait apporter deux des quatre conditions : la séparation d'origine implémentée, et la
récupération enfin offerte. **#161 apporte la première seulement.** La seconde est la tranche 2. Le
gate reste fermé, et le verrouillage (#25) manque de toute façon.

## Ce que la revue de sécurité a changé

La revue de la [PR #166](https://github.com/pinfada/railsbox-vault/pull/166) — dix constats, aucun
critique — a tenu la frontière sous neuf tentatives forgées : le port privilégié n'a jamais été
transféré, la navigation RÉELLE du sommet a été refusée, les quatre documents de la coquille n'ont
pas pu être récupérés depuis le cadre, un port re-transféré vers un Worker de l'application n'a
rendu que l'état, et trois cents annonces rejouées n'ont octroyé qu'un seul port. Ce que la revue a
trouvé ne porte donc pas sur la topologie, mais sur ce que la coquille FAIT de ce qu'elle reçoit —
et sur trois épreuves qui ne mesuraient pas ce qu'elles disaient mesurer.

| Constat                                                                          | Ce qui a changé                                                                                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| le jeton du harnais est dans l'arbre publié, et l'épreuve s'excluait du balayage | la PROMESSE est corrigée, pas déplacée : le jeton est public, la porte est une discipline, et ce qui protège est éprouvé (décision 4)           |
| un geste ADMIS restait muet dès que deux requêtes étaient en vol                 | identifiant de corrélation dans le contrat v1, rendu tel quel ; refus typé si absent, dupliqué, ou au-delà de la borne en vol                   |
| relevé non borné, recopiant les octets du guest                                  | le relevé COMPTE par code et ne recopie rien ; deux bornes nommées au décodage ; épreuve à mille messages                                       |
| la sonde de navigation du sommet mesurait un refus de LECTURE                    | elle appelle `replace` sans rien lire, et se déclare indisponible hors d'un cadre                                                               |
| aucun appât, aucune fouille du trafic                                            | la fixture enregistre les deux sens, l'épreuve y cherche les octets réels des clés, avec son témoin de fouille                                  |
| le Worker de confiance franchissait la porte du harnais sans être inscrit        | `tests/unit/harnais-portes.test.mjs` énumère désormais les appelants, et exige que l'unique appelant de PRODUIT nomme l'issue qui l'en retirera |
| décodage strict sur l'enveloppe seulement                                        | une requête admise ne porte aucun champ hors du contrat, et un transférable vers la coquille est refusé nommément                               |
| les citations de la dérivation n'étaient ancrées que par un numéro de ligne      | la forme devient `chemin:ligne › « fragment »`, et le fragment ancre                                                                            |
| le témoin de publication acceptait `sans-cadre` inconditionnellement             | il l'accepte seulement quand la règle d'origine ne conclut pas                                                                                  |
| trois gardes hors campagne de mutation                                           | la table passe de quinze à vingt-trois entrées                                                                                                  |

Deux de ces corrections ont demandé de RÉÉCRIRE une épreuve plutôt que d'en ajouter une, et c'est le
fait le plus utile de la revue : une garde peut être juste et n'être mesurée par rien. Le balayage
du jeton s'excluait du seul fichier qui portait la valeur ; la sonde de navigation levait avant
d'atteindre le geste qu'elle nommait. Les deux étaient vertes.

## Alternatives rejetées

- **Promouvoir la coquille du spike.** Écartée par la décision 1 : elle est écrite « compétente, PAS
  durcie », plante des appâts délibérés, et sa promotion aurait fait disparaître le témoin positif
  de `SEC-ORIGIN-001`. Le coût de la coquille neuve — un contrat à écrire — est exactement le
  travail que l'ADR 0002 avait réservé.
- **Un refus GÉNÉRIQUE pour tous les gestes interdits.** Écarté : l'épreuve de l'application
  malveillante n'aurait plus pu distinguer un refus d'une incompréhension.
- **Admettre « la taille du volume » par précaution.** Écarté : aucun usage ne la demande, et un
  geste sans usage n'entre pas. C'est la règle que l'ADR 0002 pose, et l'appliquer contre la
  tentation est la seule façon qu'elle veuille dire quelque chose.
- **Faire porter la vérification d'origine par un champ du message.** Écarté : une origine annoncée
  par celui qu'on vérifie ne vérifie rien.
- **Écrire les gardes dans `public/main.mjs`.** Écarté : elles n'auraient été éprouvables que par un
  navigateur, donc jamais par une campagne de mutation — et une garde qu'aucune mutation ne peut
  atteindre est une garde qu'on croit sur parole.

## Conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- une preuve reproductible qu'un script du document applicatif obtient, sur un moteur de la matrice
  cible, l'un des dix gestes de la liste de refus, ou le canal privilégié ;
- un besoin RÉEL de l'application de référence, ou d'un scénario de bout en bout, qu'aucun des deux
  gestes admis ne couvre — la liste grandirait alors par dérivation, jamais par précaution ;
- une contrainte de plate-forme qui rendrait l'ordre « canal privilégié avant tout document »
  intenable ;
- l'apparition d'un besoin de cookie de coquille : la décision 3 serait alors rouverte, sous la
  forme qu'elle fixe déjà (`__Host-`, rien sur le domaine parent).
