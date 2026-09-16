# ADR 0040 — Le parcours est un ordre, pas une décision

- **Statut** : accepté
- **Date** : 2026-09-14 (amendé le même jour après la revue d'intégration et d'accessibilité de la
  PR #213)
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

| Rang | Étape                                            | Écrans                                                                                   | Gestes (inchangés)                                                                             |
| ---- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | Créer votre coffre                               | `creer` (ou `refuse`)                                                                    | aucun : « Commencer », « J'ai déjà une sauvegarde »                                            |
| 2    | Choisir comment l'ouvrir                         | `choisir`                                                                                | `ouvrir-par-phrase`, `ouvrir-par-passkey` (le premier crée le coffre)                          |
| 3    | Recevoir et confirmer votre code de récupération | `code-annonce`, `code-feuille`, `code-confirmation` ; `code-verifier`, `code-a-verifier` | `creer-recuperation` UNE fois, puis une recopie jugée dans la page, ou l'ouverture par le code |
| 4    | Travailler dans l'application                    | `travailler` (ou `travailler-sans-application` sous Firefox)                             | `demarrer-application`, `reprendre-l-installation`                                             |
| 5    | Verrouiller et rouvrir                           | `verrouiller`, `rouvrir`                                                                 | `verrouiller-le-coffre`, `ouvrir-par-phrase`                                                   |
| 6    | Sauvegarder votre coffre                         | `sauvegarder`                                                                            | `sauvegarder-le-coffre`                                                                        |
| 7    | Restaurer sur un autre appareil                  | `restaurer-ailleurs` (coffre présent), `restaurer`                                       | `restaurer-le-coffre`                                                                          |
| 8    | Récupérer votre coffre avec le code              | `recuperer-preparer` (coffre ouvert), `recuperer`                                        | `verrouiller-le-coffre`, `ouvrir-par-code`                                                     |
| 9    | Révoquer en urgence                              | `revoquer`, `termine`                                                                    | `revoquer-en-urgence`                                                                          |

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
   > codes ; et l'écran `code-a-verifier` gagne UNE sortie — « Je n'ai plus cette feuille — afficher
   > un nouveau code » — qui ramène à `code-annonce`, où le geste d'avant crée le code après que la
   > personne a préparé son papier. Aucun écran neuf, aucun geste neuf, aucun refus neuf.
   >
   > La première rédaction de cette limite — « l'ancien reste valable tant qu'il n'est pas révoqué »
   > — était fausse quand elle a été écrite, et elle redevient VRAIE : N feuilles ouvrent le coffre,
   > et retirer celle que l'on n'a plus est un geste distinct, la révocation d'urgence de l'étape 9.
   > L'écran nomme les deux sorties. Reste hors de cette tranche : retirer UN code nommément, sans
   > toucher aux autres moyens — c'est #218.

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
