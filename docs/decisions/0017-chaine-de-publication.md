# ADR 0017 — La chaîne de publication sert les mêmes en-têtes que le serveur de test, et inventorie ce qu'elle publie

- Statut : accepté
- Date : 2026-08-28
- Issue : #45 · Invariants : `SEC-UPDATE-001`, `SEC-ORIGIN-001`, `VAULT-DIST-001` · Jalon 2

## Contexte

Trois documents attendaient cette décision, et chacun l'attendait pour une raison différente.

L'[ADR 0002](0002-topologie-origine-de-confiance.md) fait vivre le document applicatif sur une
**autre origine** que la coquille. Elle a comparé domaine propre, second compte GitHub et hébergeur
distinct, puis a écrit : « le choix appartient à la publication (#45) et n'est pas figé ici ». Elle
a aussi laissé deux risques résiduels à #45 : « deux publications à faire coïncider », et « la
frontière ne protège pas d'une publication coquille altérée : `SEC-UPDATE-001` et #45 restent la
seule réponse ».

L'[ADR 0010](0010-isolation-multi-origine.md) a écarté COEP sur mesure, et **séparé COOP de COEP**.
Elle recommande `Cross-Origin-Opener-Policy: same-origin` sur l'origine de confiance, en en faisant
une **exigence différée** vers #45 : « #45 doit donc trancher explicitement l'une des deux voies, ou
consigner qu'elle renonce à COOP et pourquoi. Le témoin `window.opener === null` est la preuve
attendue de son application. » Elle note en outre que `tools/serve.mjs` « ne sert jamais COOP
autrement qu'accompagné de COEP », et que « savoir servir COOP seul est un travail de #45 ».

`docs/release-policy.md` exige d'une version publiable un « inventaire des artefacts et empreintes
de contenu », une « procédure de rollback testée », et l'exclusion des surfaces de mesure — en
ajoutant que « la liste des chemins publiés est une décision de publication, tranchée par #45 ».

Rien de tout cela n'existait. Le dépôt savait servir ses deux origines en développement
(`tools/serve.mjs --role`), et rien ne savait en produire un artefact.

## Ce que l'expérience a établi

Protocole, environnement, commandes et mesures brutes :
[`docs/spikes/0045-chaine-de-publication.md`](../spikes/0045-chaine-de-publication.md). Les faits
qui portent la décision :

1. **Un `<meta http-equiv>` ne peut pas porter la politique de l'ADR 0013.** Mesuré sur les trois
   moteurs, avec témoin : `frame-ancestors 'none'` posé par `<meta>` est **ignoré** — le cadre se
   charge —, là où la même directive servie en en-tête, sur la même page, par le même serveur, le
   refuse. Or c'est `frame-ancestors 'none'` qui rend la coquille non encadrable, l'ADR 0010 ayant
   corrigé l'attribution erronée que le code faisait à CORP. Deux relevés annexes achèvent la
   question : COOP n'est pas exprimable par `<meta>` du tout, et un `<meta>` ne couvre pas ce qui le
   **précède** dans le flux d'analyse — un script placé avant la balise s'exécute.

2. **Les suffixes des hébergeurs par défaut sont à la Public Suffix List, et c'est à double
   tranchant.** `github.io`, `pages.dev`, `netlify.app`, `vercel.app` y figurent — vérifié par
   téléchargement de la liste, pas par citation. Deux sous-domaines y sont donc deux **sites**, pas
   seulement deux origines. Sur un **domaine propre**, à l'inverse, `vault.exemple` et
   `app.vault.exemple` sont deux origines mais **le même site** : OPFS, IndexedDB, verrous et
   diffusions restent cloisonnés — la frontière `SEC-ORIGIN-001` mesurée par l'ADR 0002 ne change
   pas —, mais **les cookies ne le sont pas**, et `SameSite` ne les sépare pas davantage.

3. **Les hébergeurs à fichier de configuration servent bien des en-têtes propres à chaque site.**
   Relevé sur des sites témoins : Cloudflare Pages, Netlify et Vercel servent des CSP qui leur sont
   propres ; aucune page GitHub Pages servie en 200 ne porte d'en-tête de sécurité, et la seule CSP
   observée sur ce service est celle de sa page d'erreur, identique pour tous les dépôts.

4. **COOP tient sa promesse, sur les trois moteurs.** Le témoin ouvre la coquille par `window.open`
   depuis un document de **l'autre origine** et relève `window.opener === null` sous Chromium 151,
   Firefox 153 et WebKit 26.5. Le témoin **négatif** — le même arbre servi sur un autre port, COOP
   retiré, la seule variable étant l'en-tête — voit `window.opener` **survivre** partout. La preuve
   demandée par l'ADR 0010 est produite, et sur trois moteurs au lieu d'un.

5. **Deux reconstructions d'un même commit rendent la même empreinte de racine, au bit près.**
   `--commit <ref>` lit les octets par `git show` ; `HEAD~1` reconstruit deux fois rend `3f13158f…`,
   `HEAD` rend `4592da46…`. Le retour arrière est donc une opération **définie** : reconstruire,
   comparer, redéposer.

6. **L'épinglage de l'ADR 0003 se vérifie sur l'arbre publié, pas seulement dans le dépôt.** La
   construction relit `vendor/v86/MANIFEST.json` **dans l'arbre** et confronte chaque artefact v86
   copié à son empreinte. C'est la moitié « runtime identifié et vérifié » de `SEC-UPDATE-001`
   portée jusqu'aux octets qui partent chez l'hébergeur.

## Décision

### 1. L'hébergement doit savoir servir des en-têtes de réponse. GitHub Pages est écarté pour l'origine de confiance

**L'origine de confiance est publiée chez un hébergeur capable d'en-têtes de réponse
personnalisés**, et le recommandé est un couple **domaine propre + sous-domaine applicatif** servi
par un hébergeur à fichier `_headers` — Cloudflare Pages ou Netlify, dont le format est identique.

GitHub Pages est écarté **pour l'origine de confiance** sur le fait 1, pas sur une préférence : la
coquille doit `frame-ancestors 'none'`, cette directive est ignorée en `<meta>`, et le seul
contournement connu — un Service Worker qui réécrit les en-têtes — ajoute du code privilégié **dans
la frontière** que #24 doit prouver, sans couvrir le premier chargement. L'ADR 0010 avait laissé
cette voie ouverte au conditionnel ; #45 la referme, et dit pourquoi : ce n'est pas le coût qui
l'écarte, c'est qu'elle mettrait du code de réécriture d'en-têtes à l'intérieur du périmètre dont
#24 doit démontrer l'étanchéité.

`_headers` est préféré à `vercel.json` pour une raison de retour arrière et non de fonctionnalité :
le même fichier est lu à l'identique par deux hébergeurs indépendants, ce qui rend le changement
d'hébergeur peu coûteux. Un reverse proxy sur hébergement statique reste équivalent
fonctionnellement ; il coûte une exploitation, et l'ADR 0017 ne l'écarte pas — il le classe après.

**Le territoire applicatif** peut vivre chez n'importe qui, y compris GitHub Pages : par décision de
l'ADR 0002 il ne reçoit **aucune** CSP. Ce qu'il doit servir se réduit à `Cache-Control`,
`X-Content-Type-Options` et `Cross-Origin-Resource-Policy: cross-origin`. Le publier tout de même
sur le sous-domaine du domaine propre est recommandé pour la seule raison qu'invoquait déjà l'ADR
0002 : la relation entre les deux origines reste lisible pour l'utilisateur.

**Conséquence à écrire, parce qu'elle n'est pas intuitive** (fait 2) : sur un domaine propre les
deux origines sont le **même site**, et les cookies ne sont donc pas cloisonnés entre elles. Cela ne
touche aucune propriété démontrée par l'ADR 0002 — le partitionnement d'OPFS, d'IndexedDB, des
verrous et des diffusions est par **origine** —, mais cela contraint #24, à qui l'ADR 0002 avait
réservé « l'allocation des cookies et du bocal de session entre les deux origines ». Un cookie posé
sur le domaine parent traverserait la frontière. La règle qui en découle, et que #24 devra tenir :
**aucun cookie de la coquille n'est posé sur le domaine parent**, et le bocal de session de
l'application reste sur son sous-domaine.

### 2. `tools/serve-headers.mjs` est la source de vérité des en-têtes servis

La production sert **ce que `securityHeaders()` rend**, sans recopie. `tools/publier-en-tetes.mjs`
appelle cette fonction et rend le `_headers` correspondant ; une épreuve unitaire vérifie que la CSP
publiée est littéralement `shellContentSecurityPolicy(origineApplicative)`.

Le motif n'est pas l'élégance. Les épreuves de frontière du dépôt — `csp-frontiere.spec.mjs`, les
sondes du spike #35 — mesurent ce que **ce module-là** sert. Une CSP recopiée à la main dans un
fichier de configuration divergerait sans bruit, et les deux vérités auraient l'air vraies : celle
qui est mesurée, et celle qui est servie.

Cet ADR ne modifie pas `tools/serve-headers.mjs`, conformément à ce que l'ADR 0010 avait posé.

### 3. Un seul en-tête est ajouté par la publication : `Cross-Origin-Opener-Policy: same-origin`

Sur l'**origine de confiance** seulement. C'est l'application de la recommandation différée de l'ADR
0010, et #45 tranche la première des deux voies qu'elle laissait ouvertes : un hébergement capable
d'en-têtes, plutôt qu'un Service Worker injecteur.

Il n'est **pas** posé sur l'origine applicative : un document encadré n'est pas un contexte de
navigation de plus haut niveau, l'en-tête y serait sans effet, et le poser violerait la règle de
l'ADR 0002 selon laquelle la coquille n'impose rien au territoire applicatif.

`same-origin` est retenu plutôt que `same-origin-allow-popups` : la coquille n'ouvre aujourd'hui
aucune fenêtre dont elle garderait la référence. Le jour où elle en ouvrirait une, l'ADR 0010 a déjà
nommé la valeur de repli.

Une épreuve unitaire vérifie que COOP est **le seul** ajout : tout autre en-tête apparu dans la
publication et absent du serveur de test fait échouer `npm run check`.

**COEP reste absent.** L'ADR 0010 l'écarte sur mesure ; rien dans #45 ne rouvre la question, et une
épreuve le vérifie sur les deux arbres.

### 4. Ce qui est publié, et ce qui ne l'est pas

La liste vit dans `tools/publier-arborescences.mjs`, chaque inclusion et chaque exclusion portant sa
raison. Sont **retirés** de l'artefact publié :

| Surface                                                 | Motif                                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `public/csp/`                                           | banc de la frontière CSP (#52, ADR 0013) : il sert des politiques **élargies** pour les mesurer                         |
| `public/spike/`                                         | bancs des spikes #35 et #41 — `spike/origin/` contient un document **hostile** et un Service Worker qui **intercepte**  |
| `public/vm/`                                            | bancs de la machine virtuelle : ils ouvrent des volumes, simulent des coupures, exposent des commandes hors du produit  |
| `public/compat.html`, `compat.mjs`, `compat-worker.mjs` | sonde de capacités #2, **exemptée** de la CSP de la coquille : la servir depuis l'origine de confiance y ferait un trou |
| `src/compat/`, `src/spike/`                             | contrats de ces bancs, dont la topologie de mesure (`origin-topology.mjs`, ports 4173/4174, documents hostiles)         |

`public/vm/` est retiré **en entier**, et non par un motif de nom : le répertoire ne contient que
des bancs, et une règle qui ne viserait que `*-banc*` laisserait passer leurs pages et leurs
Workers.

Une épreuve unitaire exige que **chaque** fichier de `public/` et de `src/` soit soit publié, soit
exclu par un motif écrit. C'est un cliquet, sur le modèle de `taille-des-fichiers.test.mjs` : un
banc ajouté demain fera échouer `npm run check` tant que personne n'aura décidé s'il est du produit.

**L'origine applicative ne publie aucun artefact du dépôt.** L'ADR 0002 dit que le HTML applicatif
est produit par le guest et relayé par le proxy ; ce que cette origine publie aujourd'hui, c'est sa
**configuration**. Le document qui s'y trouve est une **place tenante** déclarée comme telle, qui
existe pour que la frontière soit joignable et que le témoin ait quelque chose à encadrer.

### 5. L'inventaire, et ce qu'il donne à `SEC-UPDATE-001`

Chaque arbre porte un `inventaire.json` : contrat versionné, arbre, origine, commit publié,
empreinte SHA-256 et taille de **chaque** fichier, **empreinte de racine** de l'ensemble, en-têtes
déclarés, exclusions et leurs motifs, complétude, et verdict d'épinglage v86.

L'empreinte de racine porte la **liste** — chemin, taille, empreinte — sous forme canonique triée.
Un renommage la change alors que le contenu total ne bouge pas ; une somme des empreintes ne le
verrait pas.

`node tools/publier.mjs --verifier <arbre>` recalcule tout et rend trois natures d'écart, qui ne se
diagnostiquent pas de la même façon : **altéré** (publication corrompue ou construction non
reproductible), **ajouté** (une surface que personne n'a décidée — le cas que `release-policy.md`
vise), **manquant** (déploiement incomplet). Code de sortie 1 sur écart, 2 sur inventaire illisible,
5 sur épinglage v86 rompu.

**Ce que l'inventaire donne à `SEC-UPDATE-001`, précisément.** L'invariant exige que runtime et
application soient identifiés et vérifiés avant d'ouvrir un volume en écriture. Le manifeste de
volume (ADR 0007) les identifie par leurs **versions**. La publication ajoute la vérification des
**octets** : le runtime v86 servi est confronté à son épinglage dans l'arbre lui-même, et l'arbre
entier est confronté à son inventaire.

**La jonction entre les deux n'est pas faite, et cet ADR ne la fait pas.** Faut-il inscrire
l'empreinte de racine de la coquille **dans le manifeste de volume**, pour qu'un volume porte la
trace des octets du runtime qui l'a écrit ? L'idée est attirante et elle coûte cher : le manifeste
est un **format persistant** (v2 depuis #13), une identité de plus y est une version de format de
plus, et un runtime republié sous une empreinte différente — reconstruction, changement d'origine
donc de `_headers` — rendrait tout volume antérieur suspect sans qu'aucune propriété de sécurité
n'ait changé. La question est donc **posée et non tranchée** : elle appartient au format, pas à un
outil de construction, et elle est ouverte comme travail découvert.

### 6. Un changement d'origine de la coquille est une migration, pas un redéploiement

L'ADR 0002 l'a écrit et l'ADR 0009 en a livré le mécanisme : « l'OPFS de l'ancienne origine devient
inatteignable ; l'export doit précéder tout déménagement d'origine ». Cet ADR en fait une règle de
la chaîne de publication :

**Publier la coquille sur une origine différente de la précédente n'est jamais un déploiement.**
C'est une migration, qui exige, dans cet ordre :

1. l'annonce du changement d'origine aux utilisateurs, **avant** la bascule ;
2. l'**export** du volume depuis l'ancienne origine (`src/vm/volume-export.mjs`, ADR 0008), pendant
   qu'elle est encore servie ;
3. la publication sur la nouvelle origine ;
4. la **restauration** sur la nouvelle origine (`src/vm/volume-import.mjs`, ADR 0009), qui vérifie
   l'archive entière avant d'écrire un octet et n'identifie le volume qu'après l'avoir relu ;
5. le maintien en service de l'ancienne origine tant qu'un utilisateur peut n'avoir pas exporté.

La chaîne rend cette règle visible plutôt qu'elle ne l'impose : l'origine de chaque arbre est
inscrite dans son inventaire, et un changement d'origine change le `_headers`, donc l'empreinte de
racine. Une bascule d'origine ne peut donc pas passer pour un redéploiement au vu des artefacts.

### 7. Procédure de retour arrière

```sh
node tools/publier.mjs --commit <version-precedente> --sortie artifacts/rollback
node tools/publier.mjs --verifier artifacts/rollback/coquille
# comparer l'empreinte de racine à celle publiée lors de la sortie de cette version
```

La reconstruction est **reproductible au bit près** (fait 5), et c'est ce qui rend la procédure
définie. `publication.yml` l'éprouve sous `rollback-vers` : il reconstruit deux fois le même commit
et exige l'égalité des empreintes de racine.

Deux réserves qui appartiennent à la procédure, pas à l'outil : un retour arrière **ne migre rien à
l'envers** — un volume écrit par la version retirée reste écrit par elle, et le refus de downgrade
de l'ADR 0011 (`runtime.minWriter`) est ce qui protège l'utilisateur ; et `docs/release-policy.md`
exige que les artefacts d'une version retirée, la procédure de récupération et la raison du retrait
restent documentés.

### 8. La chaîne s'arrête aux artefacts, et le dit

`.github/workflows/publication.yml` est en `workflow_dispatch` **seulement**. Une chaîne qui se
déclencherait sur `push` publierait sans que personne l'ait décidé, là où `release-policy.md` fait
de la publication un acte. Elle construit, vérifie, éprouve les en-têtes sur les trois moteurs,
éprouve le retour arrière, et **dépose les deux arborescences en artefacts GitHub**. Elle ne déploie
rien.

## Ce que #45 ne fait pas

- **Aucun déploiement réel.** Il exige un compte, un domaine et des secrets, qui n'existent pas. Que
  Cloudflare Pages ou Netlify servent exactement le `_headers` produit est **documentaire** ; la
  vérification est faite localement, par un serveur qui applique ce fichier.
- **Aucune signature.** `release-policy.md` la réserve « dès que la chaîne de publication existe » :
  elle existe désormais, la signature devient donc du travail exigible — et elle n'est pas ici.
  L'inventaire n'est pas une signature, et l'outil le dit dans son en-tête : un adversaire qui
  réécrit un fichier réécrit l'inventaire. L'empreinte de racine n'a de valeur que **comparée hors
  bande**, d'où son dépôt en artefact séparé.
- **Aucun SBOM.** Exigé lui aussi par `release-policy.md`, hors périmètre de #45.
- **Aucun Service Worker**, ni pour injecter des en-têtes — voie explicitement écartée ci-dessus —
  ni pour le mode hors ligne que l'ADR 0002 prévoit en deux exemplaires.
- **Aucune décision sur le manifeste de volume** (voir § 5).

## Risques résiduels

1. **`Cache-Control: no-store` est publié tel que le serveur de test le sert.** C'est la conséquence
   directe de la règle « la production sert les mêmes en-têtes », et c'est un problème : `no-store`
   interdit toute mise en cache, alors que l'ADR 0002 prévoit **deux** Service Workers pour le mode
   hors ligne. Le conflit est nommé ici plutôt que résolu en douce ; le résoudre demande de décider
   une politique de cache par nature d'artefact — immuable pour le runtime épinglé, volatile pour la
   coquille — ce qui touche `tools/serve-headers.mjs`, hors périmètre de ce spike. **Travail
   découvert.**
2. **L'inventaire n'authentifie rien.** Voir ci-dessus. Tant que la signature n'existe pas, la seule
   défense contre une publication altérée est la comparaison hors bande d'une empreinte de racine.
3. **Les deux publications doivent coïncider** — risque n°4 de l'ADR 0002. La chaîne construit les
   deux arbres au même commit et les inventorie tous les deux, mais rien n'empêche un exploitant de
   déployer l'un sans l'autre. Le contrôle qui manque est côté **produit** : la coquille ne vérifie
   pas aujourd'hui l'identité de l'origine applicative qu'elle encadre.
4. **Les relevés d'hébergement portent sur des sites tiers.** L'absence d'un en-tête y prouve un
   choix de leur propriétaire, pas une incapacité de l'hébergeur — sauf pour GitHub Pages, dont
   l'absence de mécanisme de configuration est établie par ailleurs.
5. **La place tenante de l'origine applicative pourrait durer.** Un document déclaré provisoire qui
   reste en place devient un document. Il porte sa marque (`data-vault-place-tenante`) et l'ADR 0002
   dit ce qui doit le remplacer ; rien ne l'y force.
6. **Le domaine propre fait des deux origines un même site** (fait 2). Aucune propriété mesurée n'en
   souffre, mais la contrainte de cookies du § 1 doit être tenue par #24, et rien ne la mesure
   aujourd'hui.

## Conditions de réouverture

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- GitHub Pages, ou un autre hébergement sans en-têtes, devient capable de servir `frame-ancestors`
  et COOP — par configuration, non par `<meta>` ;
- un moteur de la matrice cible cesse d'appliquer COOP `same-origin` comme mesuré, ou l'applique
  d'une façon qui casse un usage du produit ;
- l'ADR 0010 est révisée et l'isolation devient exigée : COEP `require-corp` demanderait alors un
  en-tête au **territoire applicatif**, ce que la présente décision n'a pas prévu ;
- le produit acquiert un besoin de cache qui rend `no-store` intenable, auquel cas la politique de
  cache doit être décidée explicitement plutôt qu'héritée du serveur de test ;
- la signature des artefacts est livrée : la relation entre inventaire, empreinte de racine et
  signature doit alors être écrite, et l'inventaire cesse d'être la seule preuve d'intégrité.

## Alternatives rejetées

- **Porter la CSP par `<meta http-equiv>` pour rester sur GitHub Pages.** Mesuré insuffisant :
  `frame-ancestors` y est ignoré sur les trois moteurs, COOP n'y est pas exprimable, et la politique
  ne couvre pas ce qui précède la balise. Ce n'est pas une frontière affaiblie, c'est l'absence de
  la directive qui porte la propriété.
- **Injecter les en-têtes par un Service Worker (`coi-serviceworker` et apparentés).** Elle
  survivrait à GitHub Pages, mais met du code privilégié **dans** la frontière que #24 doit prouver,
  ne couvre pas le premier chargement, et ne fait rien pour la seconde origine. L'ADR 0010 la
  laissait au conditionnel ; #45, qui doit trancher, l'écarte.
- **Deux comptes ou deux organisations GitHub.** Gratuit, et il donne bien deux **sites** distincts
  (`github.io` est à la PSL). Il ne donne toujours aucun en-tête, ce qui suffit à l'écarter pour
  l'origine de confiance. Il reste une option pour le seul territoire applicatif, sans avantage
  lisible sur un sous-domaine du domaine propre.
- **Publier une seule origine et encadrer l'application depuis un `blob:` ou un `srcdoc`.** L'ADR
  0002 l'a mesuré : une origine opaque prive l'application de son stockage, de ses cookies et de son
  Service Worker. Ce n'est pas une économie de publication, c'est la perte du produit.
- **Recopier la CSP dans le fichier `_headers` plutôt que la dériver.** Un fichier de configuration
  qu'aucune épreuve ne relie à la politique mesurée diverge. La dérivation coûte un import.
- **Déclencher la publication sur `push` d'une étiquette.** Commode, et contraire à
  `release-policy.md`, qui fait de la publication un acte assorti d'un inventaire, d'un changelog et
  d'un rollback testé. Le déclenchement manuel est le seul qui laisse la place à ces trois choses.
- **Inscrire dès maintenant l'empreinte de la coquille dans le manifeste de volume.** Attirant, et
  prématuré : c'est un changement de format persistant, et l'empreinte d'un runtime change pour des
  raisons qui ne sont pas des changements de sécurité. Posé comme question, pas tranché (§ 5).
