# Spike D1h — le Service Worker de la coquille (#299, révision du défi C-K)

**Conservé par la PR D1h-a**
([ADR 0048](../../docs/decisions/0048-le-service-worker-de-la-coquille-sert-la-reserve-hors-connexion.md)),
depuis la branche `spike/d1h-sw-coquille` @ `101aea8` (sans PR). Rien ici n'est du produit : le SW,
le portail et le serveur d'origine sont des **bancs** destinés à être jetés (ou recopiés en D1h-b).
Rien de `public/` ni de `src/` n'est modifié. **Les sorties brutes vivent sous
`docs/mesures/spike-sw-coquille-d1h/`** et non plus sous le banc :
`tests/unit/v86-adresses.test.mjs` balaie `tools/` (`.json` compris) et refuse toute adresse
d'artefact v86 écrite en dur, or les sorties citent des chemins ; `docs/` est hors du balayage,
comme les autres mesures. Pour la même raison, `epreuves/g.mjs` dérive ses adresses du manifeste
(`src/v86-adresses.mjs`) au lieu de les écrire — seule modification du banc par rapport à `101aea8`,
et sans effet sur ce qu'il mesure. Base du banc : `main` `f619be5` (le dépôt n'a pas encore la
fusion de #298 : les épreuves ne dépendent que de l'arbre publié).

**Ce que ce banc ne satisfait pas encore** : cinq exigences ajoutées par le second contre-examen
(ADR 0048, § « Preuves ») — révocation tardive annoncée, attente muette et version plus ancienne,
API `navigator.serviceWorker` absente, identité de cache par contenu, retrait borné à l'inscription
de la coquille. Le banc reste **tel que mesuré** : les épreuves F7, F8, G7, R5 et le modèle de SW
(cache nommé par la séquence) **décrivent le prototype**, pas la décision. Ne pas les citer comme
preuve de ces cinq points ; D1h-b les livre et les éprouve (annexe A de l'ADR).

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
mesuré). Chaque exécution écrit
`docs/mesures/spike-sw-coquille-d1h/AAAA-MM-JJ-<moteurs>-<filtre>.json` : **versions de moteur**,
assertions, mesures brutes. Les sorties conservées sont celles citées dans le commentaire de #299 ;
`docs/mesures/spike-sw-coquille-d1h/anterieures/` garde une exécution antérieure du même banc (S10
sur Chromium y donne [2,1,0,1] : la redemande du script du SW à la navigation n'est pas
déterministe). `node tools/spike-sw-coquille/synthese.mjs` rend la table épreuve × moteur à partir
de `docs/mesures/spike-sw-coquille-d1h/`.

`docs/mesures/spike-sw-coquille-d1h/rejeu-d1h-a/` garde le **rejeu fait pour la PR D1h-a**
(18/11/2026, Linux arm64, Node 22.23.5, Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5) :
**201/201** couples épreuve × moteur au vert pour tous les groupes **sauf B** (le boot Rails demande
l'image de référence complète et 420 s par moteur : B1 et B2 ne sont pas rejoués, leur sortie est
celle de la branche du spike). Ce rejeu a été fait **avant** la modification de `epreuves/g.mjs`
(adresses dérivées du manifeste) ; le groupe G a été rejoué après elle, trois moteurs : **21/21**
(`--epreuves='G*'`). La commande exacte :
`node tools/spike-sw-coquille/rejouer.mjs --epreuves='S*,A*,F*,G*,D*,R*,P*,L*,M*'` (l'arbre publié
avec `artifacts/application.json` et `artifacts/reference-image` récupérés de l'artefact CI
`image-de-reference`, comme ci-dessus).

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
