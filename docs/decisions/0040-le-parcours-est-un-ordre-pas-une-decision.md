# ADR 0040 — Le parcours est un ordre, pas une décision

- **Statut** : accepté
- **Date** : 2026-09-14 (amendé le même jour après la revue d'intégration et d'accessibilité de la
  PR #213 ; amendé le 17/09/2026 — VULN-04 — et le 18/09/2026 — #239)
- **Issue** : [#193](https://github.com/pinfada/railsbox-vault/issues/193) (épique #195)
- **Ordonne, sans les changer** : les gestes de
  l'[ADR 0029](0029-deverrouillage-dans-la-coquille.md) (déverrouillage, feuille rendue une fois),
  de l'[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md) et de
  l'[ADR 0031](0031-verrouiller-le-worker-meurt-l-instantane-survit.md) (démarrer, verrouiller), de
  l'[ADR 0037](0037-reprendre-une-installation-interrompue.md) (reprendre une installation) et de
  l'[ADR 0039](0039-sauvegarder-restaurer-revoquer-depuis-la-coquille.md) (sauvegarder, restaurer,
  révoquer).
- **Ne traite pas** : l'apparence (P3, #194), tout geste nouveau, les défauts de GESTE que le
  parcours a mis au jour (#214, #215).

## Contexte

Le mainteneur, le 12/09/2026 : « il faudrait un parcours que l'on pourrait confier à un utilisateur
non technique ». Après #208, la coquille portait tous les gestes du produit, côte à côte, en HTML
nu, avec des libellés de développeur (« Ouvrir par la phrase ») et des refus rédigés pour un
exploitant (« le plancher de rejeu n'est PAS opposé », « Worker de confiance »). Tout y était, rien
n'y guidait.

La revue d'intégration et d'accessibilité de la première livraison (tête `e18470e`, quinze constats)
a montré que l'ordre se CONTOURNAIT — par l'URL, par un lien de la page, par un rechargement — et
qu'un rechargement à l'étape 3 menait la personne à confirmer un code qui n'ouvre rien. Cet ADR est
amendé en conséquence ; les décisions ci-dessous sont celles de la livraison corrigée.

## Décision

### 1. Neuf étapes, un écran à la fois

La coquille montre l'ÉTAPE courante — son rang (« Étape 3 sur 9 »), un titre, « ce qui va se passer
», « ce que vous avez à faire », l'attente annoncée quand le geste dure —, l'étape suivante
annoncée, et « Où suis-je ? » qui liste les neuf étapes (précédente, vous êtes ici, à venir, ou non
jouée sur cet appareil pour un coffre restauré). Les neuf étapes sont celles de la DoR de #193, dans
son ordre :

| Rang | Étape                                            | Écrans                                                                                    | Gestes (inchangés)                                                                                           |
| ---- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1    | Créer votre coffre                               | `creer` (ou `refuse`)                                                                     | aucun : « Commencer », « J'ai déjà une sauvegarde »                                                          |
| 2    | Choisir comment l'ouvrir                         | `choisir`                                                                                 | `ouvrir-par-phrase`, `ouvrir-par-passkey` (le premier crée le coffre)                                        |
| 3    | Recevoir et confirmer votre code de récupération | `code-annonce`, `code-feuille`, `code-a-verrouiller` ; `code-verifier`, `code-a-verifier` | `creer-recuperation` UNE fois, puis `verrouiller-le-coffre` et l'ouverture par le code (amendement du 18/09) |
| 4    | Travailler dans l'application                    | `travailler`, `accueil` après la visite (ou `travailler-sans-application` sous Firefox)   | `demarrer-application`, `reprendre-l-installation`                                                           |
| 5    | Verrouiller et rouvrir                           | `verrouiller`, `rouvrir`                                                                  | `verrouiller-le-coffre`, `ouvrir-par-phrase`                                                                 |
| 6    | Sauvegarder votre coffre                         | `sauvegarder`                                                                             | `sauvegarder-le-coffre`                                                                                      |
| 7    | Restaurer sur un autre appareil                  | `restaurer-ailleurs` (coffre présent), `restaurer`                                        | `restaurer-le-coffre`                                                                                        |
| 8    | Récupérer votre coffre avec le code              | `recuperer-preparer` (coffre ouvert), `recuperer`                                         | `verrouiller-le-coffre`, `ouvrir-par-code`                                                                   |
| 9    | Révoquer en urgence                              | `revoquer`, `termine`                                                                     | `revoquer-en-urgence`                                                                                        |

Le texte intégral de chaque écran vit dans `src/coquille/textes-du-parcours.mjs` ; la page et
[`docs/parcours/relecture-p2.md`](../parcours/relecture-p2.md) le lisent tous deux, la seconde
GÉNÉRÉE par `tools/relecture-parcours.mjs` (§ 7).

- **Pourquoi l'écran se DÉDUIT de l'état publié et de la progression.** La page lit ce que la
  coquille publie déjà — l'état du relevé, la ligne des moyens, le relevé de l'interface — et la
  progression de la personne (§ 2). Un écran tenu à côté de l'état finirait par le contredire.
- **Pourquoi aucun GESTE n'a changé.** Le parcours tient en trois modules qui lui sont propres —
  `src/coquille/parcours.mjs` (l'ordre), `src/coquille/textes-du-parcours.mjs` (ce qui est dit,
  séparé du premier par le plafond de 800 lignes) et `src/coquille/conduites-du-parcours.mjs` (les
  refus traduits) — et un module de BRANCHEMENT, `public/coquille/parcours-de-la-page.mjs`, qui
  observe les relevés et les lignes d'état, montre ou cache des blocs (`data-bloc`), renomme et
  ferme des boutons. Il n'appelle aucun geste du Worker de confiance ; aucun autre module de
  `src/coquille/` n'est touché.

### 2. L'ordre est tenu par une progression PERSISTÉE

La première livraison tenait l'étape atteinte dans l'URL (`?etape=N`) et l'état de l'étape 3 en
mémoire. La revue a montré les deux défauts : `?etape=4` après l'affichage d'un code non confirmé
menait à « Travailler » (constat 2), et un rechargement à l'étape 3 — ou le verrouillage
d'inactivité de 600 s pendant qu'on recopie — ramenait à l'annonce, qui faisait créer un SECOND code
(constat 1).

**Décision.** La progression vit dans `parcours.json`, un petit fichier de l'OPFS de l'origine de
confiance, lu au chargement et réécrit à chaque pas. Il porte l'étape atteinte, l'origine du coffre
(créé ici ou restauré), et trois faits sur le code de récupération : rendu, sa version, confirmé.
**Jamais le code** : `ecrireProgression` ne recopie que ces champs, un par un, et une progression
mal formée vaut la progression initiale. `localStorage` a été écarté : la coquille s'interdit d'y
écrire, et un fichier OPFS disparaît avec le coffre quand la personne efface les données du site.

- **L'URL ne fait que DEMANDER.** `etapeAdmise` ramène une étape demandée au-delà de l'étape
  atteinte à celle-ci, et l'URL est réécrite. Revenir en arrière reste permis.
- **Aucun écran de 4 à 9 sans code CONFIRMÉ** — et non, comme avant, sans code existant.
- **Le parcours ne recrée JAMAIS un code.** Un coffre qui porte un moyen de récupération non
  confirmé mène à « Vérifier votre code de récupération » : ouvert, la personne verrouille
  (`code-a-verifier`) ; verrouillé, elle ouvre le coffre avec le code de sa feuille
  (`code-verifier`, qui n'offre que le code). Cette ouverture VAUT confirmation — elle prouve mieux
  que la recopie que la feuille est juste. Si le code est perdu, l'écran dit comment abandonner un
  coffre encore vide : effacer les données du site dans les réglages du navigateur, recharger,
  recréer. Remplacer un code perdu n'existe pas encore (#214).
- **Ce que l'ordre protège, et ce qu'il ne protège pas.** Il protège la personne contre sa propre
  perte : on n'avance pas sans une feuille juste. Il ne protège PAS contre un adversaire qui tient
  le navigateur : le fichier se réécrit, et la vue complète des épreuves (§ 6) montre tous les
  gestes. Les gardes de sécurité restent dans les gestes du Worker de confiance, inchangées.

### 3. Le code de récupération : confirmé, puis absent de la page

L'écran `code-annonce` dit, AVANT de montrer la feuille, qu'elle ne s'affichera qu'une fois et
pourquoi elle compte (« sans lui, une phrase oubliée est un coffre perdu, et personne ne peut vous
aider »). Après « J'ai recopié mon code », la feuille est cachée et la personne retape le code
depuis son papier. `confirmerLaRecopie` rend trois refus distincts : incomplet, faute de recopie (la
somme de contrôle ISO 7064), code bien formé mais différent. Confirmé, le code est RETIRÉ de la
page.

**Aucun code en clair ne subsiste dans la page après un geste qui le consomme** (constat 3). La
première livraison recopiait la découpe du code tapé à l'étape 8 dans une région vive jamais purgée.
Désormais toute écriture du parcours passe par `texteSansCode`, qui masque un code en clair ; la
région vive de la saisie dit un COMPTE (« 18 symbole(s) sur 28 »), jamais les symboles — relire le
code à voix haute à chaque frappe le ferait entendre à qui est à côté ; et un champ vidé par le
geste vide son annonce.

### 4. Les conduites : une table pour une personne, un classement, un cliquet PAR CONSTRUCTION

`src/coquille/conduites-du-parcours.mjs` porte `CODES_DU_CHEMIN` — par geste : déverrouillage,
cycle, relais, installation interrompue, verrouillage, sauvegarde, restauration, révocation — et,
pour chaque code, une phrase écrite pour quelqu'un qui ne connaît ni le dépôt ni la cryptographie
(ce qui s'est passé, si quelque chose est perdu, quoi faire) et un CLASSEMENT : recommencer,
recopier, attendre, abandonner ce coffre, autre appareil ou navigateur, autre. La page de relecture
regroupe les conduites par classement. Les messages techniques restent, sous « Détails techniques »,
avec leur code.

Le cliquet (`tests/unit/coquille-parcours-conduites.test.mjs`) énumère les codes depuis les tables
EXPORTÉES des six familles — coquille, stockage, enveloppe, dérivation, archive, import — et non
plus depuis trois d'entre elles : vingt et un codes du stockage et de l'enveloppe, que le démarrage
remonte tels quels, n'avaient pas de conduite (constat 4). Chaque code est sur le chemin, ou écarté
par un motif « inatteignable depuis le parcours parce que … » que l'épreuve relit.

- **Aucun refus n'arrive brut dans l'alerte** (constat 5). Les refus que la coquille écrit sans code
  — une version mal tapée, une archive non choisie — sont reconnus et traduits ; un refus inconnu
  reçoit la conduite générique, et son texte reste sous « Détails techniques ».
- **Aucun texte montré ne porte de vocabulaire interne** (constat 11) : écrans, messages, statuts et
  conduites passent le même filtre (numéro d'issue, nom de fichier, code, « voisin », « racine », «
  enveloppe », « secteur », « génération », « sceau », « dérivation », « volume », « Worker », «
  coquille »…), et le filtre mord sur chacun de ces mots seul.

Les deux remarques des revues de #208 sont portées : l'écran de révocation dit que « les sauvegardes
déjà faites restent ouvrables par les anciens moyens » ; un coffre antérieur au 13/09
(`VAULT_COQUILLE_COFFRE_ANTERIEUR`) s'affiche sur l'écran `refuse` avec sa conduite.

### 5. Les attentes annoncées avant, et ce que l'écran ne dit pas pendant

- **Ouvrir par une phrase** : l'annonce de l'ADR 0029 (le p95 mesuré par moteur), redite pour une
  personne, avec la borne mesurée sous charge (« jusqu'à une minute et demie ») et « l'onglet peut
  sembler figé ».
- **Démarrer** : « environ deux minutes » avant le clic ; pendant, une PROGRESSION RÉELLE — le temps
  écoulé et le nombre de signes de vie (battements, ADR 0030 et #192) reçus du Worker depuis le
  geste, annoncée toutes les dix secondes, et un `<progress>` indéterminé. Pendant le boot, l'écran
  d'attente parle SEUL : les refus du relais ne sont annoncés qu'une fois un démarrage abouti (la
  page d'attente du cadre fait refuser des requêtes, et c'est normal ; constat 6).
- **Un geste en cours ferme ses boutons** (constat 8) : tant qu'une ligne publiée dit « en cours » —
  démarrage, reprise, verrouillage, sauvegarde, restauration — ou qu'une ouverture calcule, les
  boutons des gestes longs sont désactivés. Un second clic sur « Démarrer » faisait déclarer le
  Worker mort par silence et perdait le démarrage : ce défaut est celui du Worker, instruit sous
  #215 ; la page ne l'expose plus.
- **Sous Firefox, la limite est dite AVANT toute attente** (constat 9). Sous Firefox, l'étape 4 du
  parcours guidé n'aboutit pas dans cette version : la machine virtuelle y tourne environ six fois
  plus lentement que sous Chromium, et Rails n'y a jamais répondu (ADR 0038) ; le parcours le dit
  avant toute attente et propose Chrome ou Edge. L'écran `travailler-sans-application` n'offre ni «
  Démarrer », ni d'étape qui exige l'application ; les étapes 1 et 2 disent la limite sous Firefox ;
  aucune conduite n'envoie vers Firefox.
- **Sauvegarder, restaurer, verrouiller** : l'ordre de grandeur, et « ne fermez pas l'onglet ».

### 6. Accessibilité de base

Un seul `h1` ; le titre de l'écran est un `h2` qui reçoit le focus quand l'écran CHANGE — jamais au
premier affichage, y compris quand « Préparation » laisse place au premier écran réel (constat 12),
jamais en vue complète ; les blocs cachés ne sont pas dans l'ordre de tabulation, et l'ordre du
document est celui du parcours — l'application, à l'étape 4, vient avant « Continuer » ; chaque
champ a un `label`, et **Entrée dans un champ vaut le clic sur son bouton** (il n'y a pas de
`<form>` : la CSP porte `form-action 'none'`) ; les attentes et les réussites sont annoncées par
`role="status"`, les refus par `role="alert"` ; les boutons disent ce qu'ils font ; aucune
information n'est portée par la couleur — il n'y a pas de couleur. P3 (#194) a donné au parcours sa
mise en forme (`public/coquille/parcours.css`, `docs/direction-visuelle.md`) : contraste mesuré,
cibles de 48 px, contour de focus de 3 px, lien d'évitement, deux thèmes, `forced-colors`, et le
repli de l'aide à l'étape 4 quand Rails est prêt.

> **Note du 15/09/2026 (PR #216).** Le titre reçoit AUSSI le focus sans changement d'écran, dans un
> seul cas : quand Rails devient prêt et que le bouton « Démarrer l'application » avait le focus. Ce
> bouton disparaît de la présentation, et le focus ne doit pas tomber au document. Si le focus était
> ailleurs, il y reste. La règle « le focus suit un changement d'écran » est inchangée pour tout le
> reste.

### 7. La vue complète est un paramètre de HARNAIS, et la relecture est générée

`?vue=complete` montre tous les blocs à la fois et ouvre les détails techniques. Les épreuves
navigateur et E2E existantes jouent les gestes dans tous les ordres, y compris ceux que le parcours
n'offre pas : elles chargent la coquille avec ce paramètre — quinze adresses dans onze fichiers,
aucune assertion, aucun sélecteur. **La vue à plat n'est pas un chemin du produit** : aucun lien de
la page n'y mène (le lien « Afficher tous les gestes à la fois » de la première livraison est
retiré, constat 2), le parcours n'y ferme aucun bouton et n'y écrit pas sa progression.

La page de relecture non technique est PRODUITE depuis les textes servis
(`tools/relecture-parcours.mjs`) et `tests/unit/coquille-parcours-relecture.test.mjs` exige que la
régénération ne change rien : la première livraison, écrite à la main, omettait seize textes
affichés (constat 7). Les trois questions par étape restent écrites dans l'outil.

## Conséquences

- `public/index.html` est réordonné en blocs ; les nœuds d'état techniques (`#coquille-etat`,
  `#cycle-etat`, `#portabilite-etat`, `#parcours-progression-etat`, `#deverrouillage-refus`, les
  deux relevés…) sont sous « Détails techniques ». `#deverrouillage-refus` et `#portabilite-refus`
  ne portent plus `role="alert"` : un seul refus est annoncé, celui de `#parcours-refus`.
- `tests/browser/coquille-parcours.spec.mjs` joue l'ordre attaqué sur la coquille réelle, sans
  machine virtuelle, sur les trois moteurs : aucun second `creer-recuperation` après un
  rechargement, `?etape=` ramené, aucun lien vers la vue complète, aucun code en clair après la
  confirmation et après l'ouverture par le code, la limite de Firefox. Ces épreuves étaient rouges
  sur `e18470e`.
- L'E2E `tests/e2e/parcours-utilisateur.spec.mjs` joue les neuf étapes par ce qu'une personne voit —
  sans sélecteur CSS, les cadres par leur titre —, les trois échecs les plus probables, et ce que la
  revue a trouvé en défaut ; son délai est de quinze minutes, pour qu'un blocage échoue vite et
  laisse ses artefacts.
- Dix-huit mutants portent sur les gardes du parcours (`tools/muter-gardes-coquille.mjs`).

## Limites

1. ~~**Un code rendu puis perdu ne se remplace pas.**~~ Le constat mesuré par la revue : un second
   geste « créer un moyen de récupération », quand un moyen existe déjà, affiche un code qui n'ouvre
   ni le coffre, ni sa sauvegarde restaurée ; seul le premier ouvre.

   > **FERMÉE le 16 septembre 2026 (#214).** La cause n'était pas la CRÉATION — le second
   > emplacement de type 4 était correctement posé, scellé, version + 1, barrière franchie — mais
   > l'OUVERTURE : `deriverLeCode`, dans le Worker de confiance, prenait le PREMIER emplacement de
   > type 4 et dérivait la KEK sous son sel et son identifiant, alors que la KEK d'un code dépend
   > des deux (ADR 0021). Une fonction qui CHOISISSAIT là où il fallait ESSAYER.
   >
   > Ce qui change : l'ouverture par code dérive une KEK par emplacement de type 4 et les essaie
   > toutes, sans court-circuit (`src/coquille/ouverture-par-le-code.mjs`) ; la coquille COMPTE les
   > codes ; et les DEUX écrans « Vérifier votre code » gagnent UNE sortie — « Je n'ai plus cette
   > feuille — afficher un nouveau code ». Aucun écran neuf, aucun geste neuf, aucun refus neuf.
   >
   > **Pourquoi les deux écrans, et non le seul `code-a-verifier`.** Le brouillon de la tranche ne
   > visait que lui. Or le rechargement qui fait perdre la feuille TUE aussi le Worker de confiance
   > : la personne retombe sur `code-verifier`, coffre VERROUILLÉ, et un coffre verrouillé n'affiche
   > aucun code — le Worker n'a pas de clé. La sortie posée sur le seul écran « coffre ouvert »
   > n'aurait donc jamais servi à personne. Sur `code-verifier` elle mène à « Rouvrir », où le
   > coffre s'ouvre par la phrase ; le nouveau code s'affiche ensuite. L'ordre n'est pas sauté pour
   > autant : ouvrir par la phrase ne vaut PAS confirmation (`ouvertureParLeCode` ne nomme que les
   > écrans qui n'offrent que le code), aucun écran COFFRE OUVERT de 4 à 9 n'est atteint sans code
   > confirmé — les écrans `rouvrir` et `recuperer`, verrouillés, sont atteints sans confirmation,
   > et c'est la décision —, et la demande ne survit pas à un rechargement — elle vit dans la page,
   > jamais dans `parcours.json`.
   >
   > La première rédaction de cette limite — « l'ancien reste valable tant qu'il n'est pas révoqué »
   > — était fausse quand elle a été écrite, et elle redevient VRAIE : N feuilles ouvrent le coffre,
   > et le geste qui existe aujourd'hui est la révocation d'urgence de l'étape 9, qui retire TOUS
   > les autres moyens — phrase, passkey, autres feuilles — sauf celui employé ; retirer la seule
   > feuille perdue est #218. L'écran nomme les deux sorties.

2. **Un coffre dont la progression manque, mais qui porte un code** (créé avant cette livraison, ou
   dont `parcours.json` n'a pas pu être écrit — l'échec est publié sous « Détails techniques »)
   exige de vérifier le code en ouvrant le coffre par lui avant l'étape 4. C'est la lecture prudente
   : elle ne fait sauter aucune étape.
3. **Un second clic sur « Démarrer »** pendant un boot fait déclarer le Worker mort par silence
   (#215) : la page ferme le bouton, le défaut du Worker demeure et s'instruit sur `main`.
4. **Sous Firefox**, le parcours n'est prouvé que jusqu'à l'étape 4, qui dit sa limite (§ 5).
5. **L'étape 7 se joue sur un autre appareil ou une autre origine** : la coquille d'origine ne voit
   pas la restauration ; elle explique et laisse continuer.
6. **Le focus déplacé compte comme une activité** (`SIGNAUX_DACTIVITE`, ADR 0031) : un changement
   d'écran repousse une fois le délai d'inactivité. Il suit toujours un geste de la personne.
7. **Les pages d'attente du cadre** (P1, ADR 0038) gardent leur texte.
8. **La passkey** n'est proposée que si le navigateur connaît `PublicKeyCredential`, et l'écran dit
   qu'elle peut ne pas convenir ; aucune épreuve ne la joue (aucun authentificateur dans
   l'exécutant).
9. **Que le texte soit compris** n'est pas prouvé par une épreuve : c'est la relecture par une
   personne non technique désignée par le mainteneur, le gate humain de la tranche.

### Amendement du 2026-09-17 — état persisté non probant (VULN-04)

Les champs `code.rendu`, `code.version` et `code.confirme` de `parcours.json` ne constituent pas des
preuves : le fichier est réinscriptible. À la lecture, ils sont ramenés à leur état initial, même si
le JSON est parfaitement formé. Seules une recopie vérifiée dans la page courante ou une ouverture
réussie par code confirment la feuille. Le témoin `.engagement` authentifie une archive, pas la
recopie d'un code ; il ne remplace donc pas cette confirmation.

Conséquence assumée : un rechargement, y compris après verrouillage, redemande le code existant. La
vérification suspend la reprise à l'étape mémorisée sans permettre de l'atteindre avant succès. Si
la feuille a été perdue, l'ouverture par phrase ou passkey permet toujours d'en créer une nouvelle.
Le fichier reste en clair, sans secret ; cet amendement ne protège pas contre un script de même
origine capable de modifier aussi le code ou la mémoire de la page.

### Amendement du 2026-09-18 — la visite n'est pas l'usage, et la feuille est prouvée par le Worker (#239)

La recette QA du 18/09/2026 (PR #237, défaut 8) a trouvé l'application **inatteignable** après
l'étape 5 : verrouiller ramenait à « Vérifier votre code », l'ouverture menait à l'étape mémorisée
(6 ou 9), et aucun geste ne revenait à « Démarrer ». Le défi d'architecture du même jour l'a aggravé
: la garde des étapes 4 à 9 était `code.confirme`, que l'amendement du 17/09 remet à faux à chaque
chargement — la phrase n'ouvrait donc JAMAIS les étapes 4 à 9 —, et la seule sortie, « Je n'ai plus
cette feuille », créait un code à chaque fois, jusqu'à remplir l'enveloppe (huit emplacements).
Décision du superviseur, DoR gelée le 18/09 (commentaire de #239) : **simplifier**.

**Ce que cet amendement GARDE de celui du 17/09.** `parcours.json` reste non probant : ses faits sur
le code (`code.rendu`, `code.version`) sont remis à l'initiale à la lecture, et aucun champ du
fichier n'ouvre un écran de travail. Le fichier reste sans secret.

**Ce qui le complète (§ 2).**

- **La garde des étapes 4 à 9 est le CONSTAT du Worker de confiance**, `feuilleEprouvee` : après
  toute ouverture, le Worker relit le secteur 1 du volume `coquille` (note du 18/09 à
  l'[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md)), où il a inscrit, après chaque
  ouverture réussie PAR LE CODE, l'identifiant de l'emplacement qui a ouvert ; la feuille est
  éprouvée si l'un de ces identifiants est ENCORE un emplacement de récupération de l'enveloppe. Il
  publie ce booléen dans les réponses d'ouverture et d'inventaire, et la coquille le relève dans le
  même relevé que l'état ouvert. Aucune affirmation de la page ne franchit la frontière : un message
  « recopie vérifiée » se forgerait aussi facilement que le fichier (défi du 18/09, K).
- **`parcours.json` passe au format 2**, avec deux INDICES : `feuilleEprouvee` (recopie du dernier
  constat, pour choisir le PREMIER formulaire d'un coffre verrouillé : « Vérifier votre code » ou «
  Rouvrir votre coffre ») et `visiteTerminee` (l'étape 4 devient l'accueil). Un indice falsifié
  coûte au pire un détour d'un écran : ouvert par la phrase sans preuve, le coffre retombe sur la
  vérification, et l'indice est corrigé. Le format 1 se relit : l'étape et l'origine, jamais une
  feuille éprouvée — un coffre d'avant la correction demande son code UNE fois.
- **Une ouverture de ROUTINE mène à l'étape 4** : depuis `rouvrir` et `code-verifier` hors de
  l'étape 5, depuis `recuperer` hors de l'étape 8. Seuls les exercices de la visite avancent (5 → 6,
  8 → 9). C'est aussi la cause de ce que la QA avait vu : une origine RESTAURÉE ne s'ouvre que par
  `recuperer`, dont l'ouverture menait à 9 quelle que soit l'étape demandée — `?etape=4` n'y
  changeait rien. Accepté par la revue de sécurité de la PR #244 (LOW) : une vraie preuve jointe à
  un `parcours.json` falsifié (étape 9) peut mener à l'étape 9 par « J'ai oublié ma phrase » ; c'est
  un écran que la preuve autorise déjà, et l'ordre ne protège que la personne (§ 2).
- **L'ordre tient vers l'avant, il ne retient personne vers l'arrière.** `etapeAdmise` est inchangée
  ; les écrans 5 à 9 et `termine` portent « Revenir à mon application » (geste de page, → 4), et «
  Continuer » depuis l'étape 4 mène à la prochaine étape NON jouée.
- **Après « Parcours terminé »**, l'étape 4 est l'écran `accueil` : la visite est dite finie, et il
  porte l'application, verrouiller, sauvegarder et révoquer — des gestes qui existaient. Aucun fait
  « volume application » n'est publié : « Démarrer » choisit déjà entre installation, instantané et
  boot à froid. T2 de #236 ajoutera « Mettre à jour l'application » comme BLOC de ces deux écrans,
  jamais comme une étape.

**Ce qui remplace le § 3 (la recopie jugée dans la page).** La confirmation de l'étape 3 EST une
ouverture par le code : annonce → feuille (code rendu une fois, ADR 0025 décision 3 inchangée) → «
J'ai recopié mon code » → `code-a-verrouiller` (« verrouillez votre coffre », « Revoir mon code »
tant que le code est dans la page) → le verrouillage RECHARGE la page, et le code part avec le
document → `code-verifier` (« ouvrez-le avec le code de votre feuille ») → preuve inscrite →
étape 4. L'écran `code-confirmation`, `confirmerLaRecopie` et la comparaison au DOM disparaissent.
Risque assumé : une personne qui a mal recopié l'apprend coffre fermé ; la phrase et « Je n'ai plus
cette feuille » l'en sortent, et rien n'est perdu (le coffre est vide à l'étape 3). L'étape 5
redevient « rouvrir par la phrase ou la passkey ».

**L'enveloppe pleine.** `code-annonce` ne s'atteint plus, un code existant, que par « Je n'ai plus
cette feuille », et y offre « Revenir : j'ai toujours ma feuille » et la révocation d'urgence. Le
refus `VAULT_ENVELOPPE_PLEINE` au neuvième emplacement (établi par
`coquille-preuve-de-la-feuille.test.mjs`) dit cette sortie : révoquer retire tous les autres moyens,
puis un code se crée. Le retrait d'une seule feuille reste à #218.

### Amendement du 2026-09-19 — l'étape 9 est facultative, et la phrase oubliée n'avance pas la visite (recette QA de la PR #244)

La recette QA manuelle de la PR #244 a trouvé quatre défauts majeurs ; décision du superviseur,
datée sur #239.

- **L'étape 9 est FACULTATIVE.** Elle exécutait une vraie révocation d'urgence : ouverte par le code
  à l'étape 8, elle retirait la phrase, et toute ouverture passait ensuite par « Récupérer… avec le
  code » — alors que l'écran 3 et le README disaient « ensuite, votre phrase suffit ». Une visite ne
  détruit pas le moyen d'ouverture quotidien de la personne. L'écran `revoquer` explique le geste,
  dit sa CONSÉQUENCE en clair (« votre phrase et votre passkey ne fonctionneront plus sur ce coffre
  ; seul le code de votre feuille l'ouvrira ») et offre deux sorties : « Révoquer tous les autres
  moyens… » (inchangé) et « Terminer sans révoquer » (écran `termine-sans-revoquer`). La révocation
  reste sur l'accueil, avec le même avertissement. Redonner une phrase à un coffre révoqué est hors
  de cette tranche (issue à part).
- **« J'ai oublié ma phrase » est une ouverture de ROUTINE.** Elle menait à l'étape 8
  (`rouvrir:perdu`), donc à 9 après l'ouverture, et marquait 5 à 8 comme faites : un saut vers
  l'AVANT, contraire au § 2. Elle montre désormais le formulaire du code sans déplacer la visite ;
  l'ouverture mène à l'étape 4. Seule l'étape 8 atteinte PAR LA VISITE avance vers 9. Ceci corrige
  la classification « conforme » de la revue de sécurité (LOW) écrite plus haut.
- **« Où suis-je ? » dit la vérité** : une étape est « passée » quand la visite est allée au-delà ;
  la visite finie, aucune n'est en cours ni à venir. Hors de la visite (réouverture de routine,
  phrase oubliée, accueil), un titre ne porte plus de numéro d'étape.
- **« Verrouiller » reste visible et atteignable au clavier à l'accueil, application démarrée** : le
  repli de Rails prêt ne retire plus que « Démarrer ».
