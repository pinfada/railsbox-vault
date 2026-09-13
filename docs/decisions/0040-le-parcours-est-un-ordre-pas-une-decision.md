# ADR 0040 — Le parcours est un ordre, pas une décision

- **Statut** : accepté
- **Date** : 2026-09-14
- **Issue** : [#193](https://github.com/pinfada/railsbox-vault/issues/193) (épique #195)
- **Ordonne, sans les changer** : les gestes de
  l'[ADR 0029](0029-deverrouillage-dans-la-coquille.md) (déverrouillage, feuille rendue une fois),
  de l'[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md) et de
  l'[ADR 0031](0031-verrouiller-le-worker-meurt-l-instantane-survit.md) (démarrer, verrouiller), de
  l'[ADR 0037](0037-reprendre-une-installation-interrompue.md) (reprendre une installation) et de
  l'[ADR 0039](0039-sauvegarder-restaurer-revoquer-depuis-la-coquille.md) (sauvegarder, restaurer,
  révoquer).
- **Ne traite pas** : l'apparence (P3, #194), tout geste nouveau.

## Contexte

Le mainteneur, le 12/09/2026 : « il faudrait un parcours que l'on pourrait confier à un utilisateur
non technique ». Après #208, la coquille portait tous les gestes du produit, côte à côte, en HTML
nu, avec des libellés de développeur (« Ouvrir par la phrase ») et des refus rédigés pour un
exploitant (« le plancher de rejeu n'est PAS opposé », « Worker de confiance »). Tout y était, rien
n'y guidait.

## Décision

### 1. Neuf étapes, un écran à la fois

La coquille montre l'ÉTAPE courante — son rang (« Étape 3 sur 9 »), un titre, « ce qui va se passer
», « ce que vous avez à faire », l'attente annoncée quand le geste dure —, l'étape suivante
annoncée, et « Où suis-je ? » qui liste les neuf étapes (précédente, vous êtes ici, à venir). Les
neuf étapes sont celles de la DoR de #193, dans son ordre :

| Rang | Étape                                            | Écrans                                              | Gestes (inchangés)                                                    |
| ---- | ------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------- |
| 1    | Créer votre coffre                               | `creer` (ou `refuse`)                               | aucun : « Commencer », « J'ai déjà une sauvegarde »                   |
| 2    | Choisir comment l'ouvrir                         | `choisir`                                           | `ouvrir-par-phrase`, `ouvrir-par-passkey` (le premier crée le coffre) |
| 3    | Recevoir et confirmer votre code de récupération | `code-annonce`, `code-feuille`, `code-confirmation` | `creer-recuperation`, puis une recopie jugée dans la page             |
| 4    | Travailler dans l'application                    | `travailler`                                        | `demarrer-application`, `reprendre-l-installation`                    |
| 5    | Verrouiller et rouvrir                           | `verrouiller`, `rouvrir`                            | `verrouiller-le-coffre`, `ouvrir-par-phrase`                          |
| 6    | Sauvegarder votre coffre                         | `sauvegarder`                                       | `sauvegarder-le-coffre`                                               |
| 7    | Restaurer sur un autre appareil                  | `restaurer-ailleurs` (coffre présent), `restaurer`  | `restaurer-le-coffre`                                                 |
| 8    | Récupérer votre coffre avec le code              | `recuperer-preparer` (coffre ouvert), `recuperer`   | `verrouiller-le-coffre`, `ouvrir-par-code`                            |
| 9    | Révoquer en urgence                              | `revoquer`, `termine`                               | `revoquer-en-urgence`                                                 |

Le texte intégral de chaque écran vit dans `src/coquille/parcours.mjs` et se relit, tel qu'il
s'affiche, dans [`docs/parcours/relecture-p2.md`](../parcours/relecture-p2.md).

- **Pourquoi l'écran se DÉDUIT de l'état publié.** La page lit ce que la coquille publie déjà —
  l'état du relevé, la ligne des moyens, le relevé de l'interface — et l'étape atteinte. Un écran
  tenu à côté de l'état finirait par le contredire : un coffre ouvert sans moyen de récupération
  ramène donc TOUJOURS à l'étape 3, quel que soit le numéro d'étape.
- **Pourquoi l'étape atteinte vit dans l'URL (`?etape=N`).** Le verrouillage recharge la coquille
  (ADR 0031) ; sans trace, la personne reviendrait à l'étape 1. La coquille n'écrit dans aucun
  stockage du navigateur (`coquille-deverrouillage.test.mjs`), et un numéro d'étape n'y a rien à
  faire. L'URL survit au rechargement et ne porte rien du coffre.
- **Pourquoi aucun module de `src/coquille/` n'a changé.** Le parcours est un module de BRANCHEMENT
  de plus (`public/coquille/parcours-de-la-page.mjs`) qui observe les relevés et les lignes d'état,
  montre ou cache des blocs (`data-bloc`) et renomme des boutons. Il n'appelle aucun geste du Worker
  de confiance. Les campagnes de mutation ne voient donc aucun code muté changer.

### 2. Le code de récupération est confirmé avant d'avancer

L'écran `code-annonce` dit, AVANT de montrer la feuille, qu'elle ne s'affichera qu'une fois et
pourquoi elle compte (« sans lui, une phrase oubliée est un coffre perdu, et personne ne peut vous
aider »). Après « J'ai recopié mon code », la feuille est cachée et la personne retape le code
depuis son papier. `confirmerLaRecopie` rend trois refus distincts : incomplet, faute de recopie (la
somme de contrôle ISO 7064), code bien formé mais différent. Confirmé, le code est RETIRÉ de la page
— il n'y avait plus rien à faire. Le Worker ne voit rien de cette confirmation : c'est une
comparaison dans la page, avec le texte déjà affiché, et aucune copie n'est faite ailleurs.

### 3. Les conduites : une table pour une personne, et un cliquet

`src/coquille/conduites-du-parcours.mjs` porte `CODES_DU_CHEMIN` — par geste : déverrouillage,
cycle, relais, installation interrompue, verrouillage, sauvegarde, restauration, révocation — et
`CONDUITES_DU_PARCOURS`, une phrase par code, écrite pour quelqu'un qui ne connaît ni le dépôt ni la
cryptographie : ce qui s'est passé, si quelque chose est perdu, quoi faire. Les messages techniques
restent, sous « Détails techniques » (replié), avec leur code.

Le cliquet (`tests/unit/coquille-parcours-conduites.test.mjs`) exige : chaque code du chemin a une
conduite ; chaque code est un vrai code du dépôt ; chaque code de la coquille, de l'archive et de la
restauration est sur le chemin OU écarté nommément (`CODES_HORS_DU_CHEMIN`, avec son motif — les
refus du port restreint, de l'annonce du cadre et du contrat de messages, qu'aucun geste de la
personne ne produit) ; aucune conduite ne porte de vocabulaire interne (numéro d'issue, nom de
fichier, code, « voisin », « racine », « enveloppe », « Worker », « coquille »…), et le filtre MORD.

Les deux remarques des revues de #208 sont portées : l'écran de révocation dit que « les sauvegardes
déjà faites restent ouvrables par les anciens moyens » ; un coffre antérieur au 13/09
(`VAULT_COQUILLE_COFFRE_ANTERIEUR`) s'affiche sur l'écran `refuse` avec sa conduite.

### 4. Les attentes annoncées avant

- **Ouvrir par une phrase** : l'annonce de l'ADR 0029 (le p95 mesuré par moteur), redite pour une
  personne, avec la borne mesurée sous charge (« jusqu'à une minute et demie ») et « l'onglet peut
  sembler figé ».
- **Démarrer** : « environ deux minutes » avant le clic ; pendant, une PROGRESSION RÉELLE — le temps
  écoulé et le nombre de signes de vie (battements, ADR 0030 et #192) reçus du Worker depuis le
  geste, annoncée toutes les dix secondes pour ne pas saturer un lecteur d'écran, et un `<progress>`
  indéterminé. Ce n'est pas un pourcentage : le Worker ne publie aucun avancement du boot, et le
  parcours n'en invente pas.
- **Sauvegarder, restaurer, verrouiller** : l'ordre de grandeur, et « ne fermez pas l'onglet ».

### 5. Accessibilité de base

Un seul `h1` ; le titre d'étape est un `h2` qui reçoit le focus quand l'écran change (jamais au
premier affichage, jamais en vue complète) ; les blocs cachés ne sont pas dans l'ordre de
tabulation, et l'ordre du document est celui du parcours ; chaque champ a un `label` ; les attentes
et les réussites sont annoncées par `role="status"` (`aria-live="polite"`), les refus par
`role="alert"` ; les boutons disent ce qu'ils font (« Créer mon coffre », « Verrouiller mon coffre
», « Restaurer ma sauvegarde sur cet appareil ») ; aucune information n'est portée par la couleur —
il n'y a pas de couleur. P3 (#194) fera le reste.

### 6. La vue complète, pour les épreuves de frontière

`?vue=complete` montre tous les blocs à la fois et ouvre les détails techniques. Les épreuves
navigateur et E2E existantes jouent les gestes dans tous les ordres, y compris ceux que le parcours
n'offre pas (démarrer avant d'ouvrir, sauvegarder un coffre verrouillé) : elles chargent désormais
la coquille avec ce paramètre. C'est la SEULE modification de ces épreuves — onze adresses, aucune
assertion, aucun sélecteur ; les identifiants des gestes sont inchangés. Le lien « Afficher tous les
gestes à la fois » est dans les détails techniques.

## Conséquences

- `public/index.html` est réordonné en blocs ; les nœuds d'état techniques (`#coquille-etat`,
  `#cycle-etat`, `#portabilite-etat`, `#deverrouillage-refus`, les deux relevés…) sont sous «
  Détails techniques ». `#deverrouillage-refus` et `#portabilite-refus` ne portent plus
  `role="alert"` : un seul refus est annoncé, celui de `#parcours-refus`.
- L'E2E `tests/e2e/parcours-utilisateur.spec.mjs` joue les neuf étapes par les libellés visibles, et
  les trois échecs les plus probables (code mal recopié, mauvaise phrase, archive altérée).

## Limites

1. **Un rechargement pendant l'étape 3** perd le code affiché (il n'est nulle part ailleurs, par
   décision) : l'étape 3 revient à son annonce, et la personne crée un nouveau moyen de
   récupération. L'ancien reste valable tant qu'il n'est pas révoqué.
2. **L'étape 7 se joue sur un autre appareil ou une autre origine** : la coquille d'origine ne voit
   pas la restauration ; elle explique et laisse continuer.
3. **Le focus déplacé compte comme une activité** (`SIGNAUX_DACTIVITE`, ADR 0031) : un changement
   d'écran repousse une fois le délai d'inactivité. Il suit toujours un geste de la personne.
4. **Les pages d'attente du cadre** (P1, ADR 0038) gardent leur texte ; le parcours affiche la
   conduite des refus de relais qu'il voit passer au relevé, sous l'application.
5. **La passkey** n'est proposée que si le navigateur connaît `PublicKeyCredential`, et l'écran dit
   qu'elle peut ne pas convenir ; l'E2E ne la joue pas (aucun authentificateur dans l'exécutant).
6. **Que le texte soit compris** n'est pas prouvé par une épreuve : c'est la relecture par une
   personne non technique désignée par le mainteneur, le gate humain de la tranche.
