# Spike D1h — le Service Worker de la coquille (#299, révision du défi C-K)

**Branche `spike/d1h-sw-coquille`, sans PR.** Rien ici n'est du produit : le SW, le portail et le
serveur d'origine sont des **bancs** destinés à être jetés (ou recopiés en D1h-b). Aucun fichier
hors `tools/spike-sw-coquille/` n'est modifié. Base : `main` `f619be5` (le dépôt n'a pas encore la
fusion de #298 : les épreuves ne dépendent que de l'arbre publié).

## Rejouer

```sh
# Node 22 (`.node-version`), puis, depuis la racine du dépôt :
npm ci
npx playwright install chromium firefox webkit      # (+ `sudo npx playwright install-deps webkit` sous Linux)
npm run vm:fetch                                     # artefacts v86 (libv86, v86.wasm…)
# L'arbre PUBLIÉ (ports figés : ils sont écrits dans la CSP `frame-src` du `_headers`) :
node tools/publier.mjs --sortie artifacts/publication-spike \
  --origine-application http://localhost:4294 --origine-coquille http://127.0.0.1:4293
# Pour B (boot Rails) : l'image de référence — `npm run image:build` (Docker) ou, hors Docker, l'artefact CI
# `image-de-reference` d'un run `reprise.yml` : gh run download <id> -n image-de-reference -D /tmp/img
#   cp -r /tmp/img/reference-image /tmp/img/application.json artifacts/

node tools/spike-sw-coquille/rejouer.mjs                            # tout, trois moteurs
node tools/spike-sw-coquille/rejouer.mjs --moteurs=chromium --epreuves='A*,F*'
SPIKE_BUDGET_DEMARRAGE_MS=420000 node tools/spike-sw-coquille/rejouer.mjs --epreuves=B1,B2   # boot Rails
```

Un navigateur neuf par épreuve (Firefox garde un état de connexion après un serveur arrêté :
mesuré). Chaque exécution écrit `sorties/AAAA-MM-JJ-<moteurs>-<filtre>.json` : **versions de
moteur**, assertions, mesures brutes. Les sorties conservées dans ce dossier sont celles citées dans
le commentaire de #299 ; `sorties/anterieures/` garde une exécution antérieure du même banc (S10 sur
Chromium y donne [2,1,0,1] : la redemande du script du SW à la navigation n'est pas déterministe).
`node tools/spike-sw-coquille/synthese.mjs` rend la table épreuve × moteur à partir de `sorties/`.

## Carte des épreuves

| Groupe         | Point du constat  | Contenu                                                                                                                           |
| -------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `s.mjs` S1–S22 | MEDIUM 4 (rejeu)  | les épreuves du défi C-K, rejouées (S17, S19, S20 n'y figuraient pas)                                                             |
| `a.mjs` A1–A4  | HIGH 1            | deux onglets, mise à jour, `controllerchange`, import tardif, fermeture de tous les clients ; mutants `skipWaiting`, `claim`      |
| `f.mjs` F0–F8  | HIGH 2            | six états de fraîcheur, courses, installation rejetée/lente, origine qui pend, hors ligne, révocation connue, limites du plancher |
| `g.mjs` G1–G6  | HIGH 3            | aucun contrôleur, premier contrôle, URL inattendue, variantes de requête, redirections, types MIME ; garde fermée                 |
| `d.mjs` D0–D2  | MEDIUM 4          | `fetch` + `WebAssembly.instantiate(octets)` d'Argon2, double barrière, Worker de dérivation réel                                  |
| `r.mjs` R1–R6  | MEDIUM 5          | retrait : onglets actifs, attente, réseau coupé, interruptions, caches du produit seuls, geste                                    |
| `p.mjs` P0–P6  | MEDIUM 6          | portail : silence du SW, messages, changement de contrôleur, altération après le portail, quota, coupure                          |
| `l.mjs` L1–L2  | LOW 7             | requête inter-origine du propre client, méthodes hors GET                                                                         |
| `m.mjs` M1–M7  | MEDIUM 6          | matrice des mutants (nominal tient, mutant rompt)                                                                                 |
| `b.mjs` B1–B2  | point 8, MEDIUM 4 | E2E sur l'arbre publié, en-têtes de production, sans harnais : déverrouillage + boot Rails, refus sans boot                       |

## Ce que ce banc n'est pas

- Pas le produit : le portail typé, l'enregistrement du SW par la page, la liste générée à la
  publication et les codes au registre sont D1h-b.
- Les **mutants** sont des interrupteurs dans le code du banc, pas une campagne de mutation du
  source : la campagne `reserve` de `tools/rejouer-les-campagnes.mjs` reste à écrire en D1h-b.
- Safari réel, éviction réelle, navigation privée réelle, hébergeur réel : **non mesurés** (voir le
  commentaire de #299).
