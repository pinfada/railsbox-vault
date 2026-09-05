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

### 1. Les DEUX origines exigent un hébergeur capable d'en-têtes. GitHub Pages n'est admis nulle part

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

**Le territoire applicatif obéit à la MÊME règle, et GitHub Pages n'y est pas davantage admis.**

Une première rédaction de cet ADR le laissait vivre « chez n'importe qui, y compris GitHub Pages »,
au motif qu'il ne reçoit aucune CSP de la coquille. La revue de sécurité a montré que ce motif
raisonnait sur ce que l'origine applicative ne reçoit **pas**, en oubliant ce qu'elle doit
**servir**. Elle doit servir trois en-têtes, et le relevé du fait 3 dit que GitHub Pages n'en sert
aucun :

| En-tête servi par l'origine applicative      | Ce qu'il tient                                                                      | GitHub Pages (mesuré)   |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| `Cross-Origin-Resource-Policy: cross-origin` | rend ses ressources chargeables par la coquille qui l'encadre                       | absent                  |
| `X-Content-Type-Options: nosniff`            | empêche le reniflage de type sur du contenu rendu par le guest                      | absent                  |
| `Content-Security-Policy: frame-ancestors …` | seule la coquille peut l'encadrer (§ 3 bis)                                         | absent, et inexprimable |
| `Cache-Control: no-store`                    | ce que sert le serveur de test — Pages sert `max-age=600`, donc une AUTRE politique | divergent               |

Depuis l'[ADR 0023](0023-politique-de-cache-par-nature-d-artefact.md), la dernière ligne de ce
tableau se lit autrement : `no-store` reste servi sur l'origine applicative, mais parce que ce
qu'elle sert porte les cookies de session du guest — non plus parce que le serveur de test le sert.
La divergence relevée sur GitHub Pages, elle, ne change pas.

Le territoire applicatif est donc publié, lui aussi, chez un hébergeur capable d'en-têtes. C'est la
règle la plus simple, et c'est aussi la seule qui se vérifie : `tools/publier-temoin.mjs` asserte
ces en-têtes sur les **deux** origines, et une origine incapable de les servir ferait échouer le
témoin plutôt que de dégrader la publication en silence. Une règle qui vaudrait d'un côté et pas de
l'autre demanderait une seconde table d'attentes, et cette seconde table serait celle que personne
ne relit.

**GitHub Pages n'est donc admis nulle part** dans cette chaîne. Le comparatif du spike le dit sur
les deux lignes.

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

### 3. `Cross-Origin-Opener-Policy: same-origin` sur la coquille

C'est l'application de la recommandation différée de l'ADR 0010, et #45 tranche la première des deux
voies qu'elle laissait ouvertes : un hébergement capable d'en-têtes, plutôt qu'un Service Worker
injecteur.

Il n'est **pas** posé sur l'origine applicative : un document encadré n'est pas un contexte de
navigation de plus haut niveau, et l'en-tête y serait sans effet.

`same-origin` est retenu plutôt que `same-origin-allow-popups` : la coquille n'ouvre aujourd'hui
aucune fenêtre dont elle garderait la référence. Le jour où elle en ouvrirait une, l'ADR 0010 a déjà
nommé la valeur de repli.

### 3 bis. `Content-Security-Policy: frame-ancestors <origine coquille>` sur l'application

La revue de sécurité de #45 a relevé que l'origine applicative, telle que publiée, était encadrable
par **n'importe quel site**. Ce n'est pas anodin : cette origine porte les cookies de session Rails,
son stockage et son Service Worker. Un tiers qui l'encadre obtient une surface de détournement de
clic sur une application authentifiée.

**L'ADR 0002 n'interdit pas cette directive, et il faut dire précisément pourquoi.** Ce qu'il
s'interdit est d'imposer une politique au **contenu** rendu par le guest : « lui imposer ici une CSP
reviendrait à mesurer notre propre politique au lieu de la frontière d'origine ». `frame-ancestors`
ne fait rien de tel. Elle ne gouverne pas ce que le document **charge** — ni `script-src`, ni
`connect-src`, ni `default-src` — mais seulement **qui a le droit de l'encadrer**. C'est une
propriété de l'hébergement de cette origine, comme `Cross-Origin-Resource-Policy` qui y est déjà
servi, et non une contrainte sur le code applicatif.

Cette distinction ne tient que si la directive reste **seule**. Une politique applicative qui
gagnerait un `default-src` ou un `script-src` aurait franchi la ligne de l'ADR 0002. Le témoin
d'en-têtes découpe donc la CSP reçue par l'origine applicative et **échoue** si elle contient autre
chose que `frame-ancestors`.

### 3 ter. Ces deux en-têtes sont les seuls ajouts, et une épreuve le tient

`tools/serve-headers.mjs` rend une politique par rôle ; la publication y ajoute exactement les deux
en-têtes ci-dessus, chacun sur une seule origine, chacun avec son ADR et son motif dans
`EN_TETES_AJOUTES_PAR_LA_PUBLICATION`. Une épreuve unitaire compare cette table à l'écart réellement
mesuré entre `securityHeaders()` et ce qui est publié, sur les deux arbres : un **troisième**
en-tête fait échouer `npm run check` tant qu'un ADR ne l'a pas déclaré.

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

**Elle est adressée par contenu, et elle n'est donc pas une identité de version.** Une première
rédaction la disait « liée au commit », ce qui laissait croire à une bijection : la revue de #45 a
relevé que les trois commits de la PR rendaient la même racine, parce qu'aucun ne touchait un octet
publié. C'est correct et c'est même une propriété — une tranche de documentation ne change pas
l'artefact —, mais cela signifie qu'une empreinte de racine ne **nomme** pas une version. La
formulation exacte est : l'empreinte de racine est **accompagnée** du commit dans l'inventaire. Les
deux identités sont indépendantes, et c'est le couple qui décrit une publication.

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

**Ce que la chaîne rend visible, et ce qu'elle ne rend pas.** Une première rédaction de cet ADR
affirmait ici qu'« un changement d'origine change le `_headers`, donc l'empreinte de racine ; une
bascule d'origine ne peut donc pas passer pour un redéploiement ». La revue de sécurité de #45 l'a
mesurée **fausse** : le `_headers` de la coquille ne portait l'origine **applicative** — par
`frame-src` — et sa propre origine ne vivait que dans `inventaire.json`, fichier explicitement hors
de sa propre empreinte. Deux constructions d'origines de coquille différentes rendaient la même
empreinte de racine. La bascule la plus dangereuse — celle qui rend l'OPFS de l'ancienne origine
inatteignable — était précisément celle qui ne se voyait pas.

Le `_headers` porte donc désormais `# origine: <url>` en tête. C'est un commentaire pour
l'hébergeur, qui l'ignore ; c'est un **octet servi** pour l'empreinte, qui le compte. Deux origines
rendent maintenant deux racines, sur les deux arbres — celui de l'application aussi, puisque son
`frame-ancestors` nomme la coquille (§ 3 bis). Quatre épreuves unitaires le tiennent.

L'affirmation corrigée est donc : **une bascule d'origine change l'empreinte de racine, et la
procédure de retour arrière du § 7 la distingue d'un redéploiement.** Elle reste une aide au
diagnostic, pas une garantie : rien n'empêche un exploitant de déployer sans comparer.

### 7. Procédure de retour arrière

```sh
node tools/publier.mjs --commit <version-precedente> --sortie artifacts/rollback
node tools/publier.mjs --verifier artifacts/rollback/coquille
# comparer l'empreinte de racine à celle publiée lors de la sortie de cette version
```

La reconstruction est **reproductible au bit près** (fait 5), et c'est ce qui rend la procédure
définie.

**Deux comparaisons, et elles ne prouvent pas la même chose.** La revue de sécurité de #45 a relevé
que le workflow promettait la seconde et n'exécutait que la première :

| Comparaison                                                      | Ce qu'elle prouve                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| deux reconstructions du même commit, dans le même run            | le **déterminisme** de l'outil, rien de plus                  |
| reconstruction **contre l'empreinte inscrite lors de la sortie** | qu'on republie bien **cette version-là**, et non une homonyme |

`publication.yml` fait la première toujours, et la seconde dès que l'entrée `empreinte-attendue` est
fournie — l'empreinte qu'avait inscrite la publication d'alors. Sans elle, il **le dit** dans son
journal (« seul le déterminisme est éprouvé ») plutôt que de laisser croire à la seconde. C'est la
raison pour laquelle `docs/release-policy.md` demande de conserver cette empreinte à chaque sortie :
sans elle conservée hors bande, le retour arrière est reproductible mais pas vérifiable.

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

## Amendement du 2026-09-05 — les chemins de l'inventaire nomment leur empreinte (#123)

L'inventaire ne change pas de FORME : il reste une liste `chemin`, `octets`, `sha256`, et son
empreinte de racine reste celle de cette liste sous forme canonique triée (§ 5). Ce qui change est
le contenu de la colonne `chemin` sous `vendor/v86/artefacts/`, et cela vaut d'être écrit ici parce
que cela touche deux propriétés que cet ADR défend.

**Le retour arrière (§ 7) gagne en lisibilité, et sa PROCÉDURE change.** Un ré-épinglage de
l'émulateur déplaçait déjà l'empreinte de racine — l'empreinte du fichier changeait dans la liste.
Il déplace désormais aussi le CHEMIN, si bien qu'une comparaison de deux inventaires montre
l'ancienne et la nouvelle adresse sur deux lignes voisines, et non un même chemin portant deux
empreintes.

Mais la première commande de la procédure documentée ne s'exécute plus telle qu'elle était écrite,
et la revue de sécurité de #123 l'a relevé : depuis un poste à jour, un
`node tools/publier.mjs --commit <ancien>` rend un **code 5** — les artefacts déclarés par le
manifeste d'alors sont absents, ceux d'aujourd'hui sont présents et non déclarés. Le refus est
CORRECT, et c'est même la propriété revendiquée au paragraphe suivant ; ce qui manquait est le
REMÈDE. Il tient en deux commandes, désormais écrites dans `docs/release-policy.md` § « Retour
arrière » et imprimées par l'outil lui-même quand la forme des écarts le désigne :
`git checkout <ref> -- vendor/v86/MANIFEST.json`, puis `npm run vm:fetch`. C'est un des critères qui
a fait retenir la forme SUFFIXE — `libv86-<empreinte>.mjs` — plutôt qu'un répertoire `<empreinte>/`
: la liste est triée par chemin, et un répertoire d'empreinte aurait dispersé les artefacts au
hasard de leurs SHA-256.

**La règle « les artefacts v86 viennent de l'ARBRE DE TRAVAIL même sous `--commit` » devient
autovérifiante.** Cette exception était nommée et bornée, et elle reposait sur la vérification
d'empreinte. Elle repose désormais aussi sur le nom : reconstruire un commit ANTÉRIEUR avec les
octets d'aujourd'hui sur le disque produit un arbre dont les adresses ne sont pas celles que le
manifeste de ce commit épingle, et `verifierEpinglageV86` le refuse en code 5 — au lieu de le
détecter par la seule comparaison d'empreintes.

**Un fichier de plus dans chaque arbre.** La publication dépose
`vendor/v86/artefacts/MANIFEST-<empreinte>.json`, copie du manifeste adressée par sa propre
empreinte. Elle entre dans l'inventaire comme tout autre octet servi, donc dans l'empreinte de
racine. Son motif est écrit dans l'amendement de
l'[ADR 0023](0023-politique-de-cache-par-nature-d-artefact.md) : elle rend l'épinglage remontable
depuis une adresse d'artefact, et elle donne à la classe de cache immuable un membre présent dans
tout arbre publié.

## Risques résiduels

1. **`Cache-Control: no-store` est publié tel que le serveur de test le sert.** C'est la conséquence
   directe de la règle « la production sert les mêmes en-têtes », et c'est un problème : `no-store`
   interdit toute mise en cache, alors que l'ADR 0002 prévoit **deux** Service Workers pour le mode
   hors ligne. Le conflit est nommé ici plutôt que résolu en douce ; le résoudre demande de décider
   une politique de cache par nature d'artefact — immuable pour le runtime épinglé, volatile pour la
   coquille — ce qui touche `tools/serve-headers.mjs`, hors périmètre de ce spike. **Travail
   découvert — traité par #103 et l'[ADR 0023](0023-politique-de-cache-par-nature-d-artefact.md)**,
   qui a suivi l'ordre de l'ADR 0022 : la politique est décidée dans la source de vérité et la
   publication l'en dérive. Trois natures — `no-cache` pour la coquille, un cache long pour
   l'épinglage v86, `no-store` conservé mais DÉCIDÉ pour le territoire applicatif —, donc un fichier
   `_headers` à plusieurs blocs. Depuis #123 ce cache long vaut
   `public, max-age=31536000, immutable` sur `/vendor/v86/artefacts/*`, dont chaque adresse nomme
   son empreinte ; le manifeste et les licences, eux, relèvent de `no-cache`. Deux corrections à ce
   qui est écrit ci-dessus : `immutable` a été **refusé** tant qu'aucune URL publiée ne nommait son
   empreinte — #123 a levé cette condition, voir l'amendement de l'ADR 0023 —, et « `no-store`
   interdit toute mise en cache » est trop fort — il ferme le cache HTTP, pas le magasin d'un
   Service Worker. Le cliquet de « politique uniforme » du § 4 n'est pas retiré : il devient «
   uniforme **hors** la dimension déclarée non uniforme », et une divergence de CSP, de COOP, de
   `Referrer-Policy` ou de `Permissions-Policy` entre deux chemins d'un même arbre est refusée comme
   avant.
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
7. **Aucun en-tête de durcissement générique n'est publié** — ni `Referrer-Policy`, ni
   `Permissions-Policy`, ni `Strict-Transport-Security`. Ce n'est pas un choix positif : c'est la
   conséquence mécanique de la règle « rien de plus que ce que sert le serveur de test », qui n'en
   sert aucun. La règle a une bonne raison — que les épreuves de frontière mesurent ce qui est
   publié — mais elle transforme ici une absence en décision par défaut. Les ajouter demanderait de
   les servir d'abord en développement, donc de toucher `tools/serve-headers.mjs`, hors périmètre.
   **Travail découvert — traité par #104 et l'[ADR 0022](0022-entetes-de-durcissement.md)**, qui a
   suivi cet ordre : `Referrer-Policy` et `Permissions-Policy` sont posés dans la source de vérité
   et la publication les en dérive, sans entrer dans la table du § 3 ter ;
   `Strict-Transport-Security` est explicitement écarté et son absence gardée, parce qu'il serait
   ignoré sur le `http:` de tout ce que ce dépôt sait mesurer.
8. **L'empreinte de racine ne nomme pas une version** (§ 5). Deux tranches dont aucun octet publié
   ne diffère la partagent. Une procédure qui l'emploierait seule pour identifier « la version
   déployée » se tromperait ; c'est le couple (empreinte, commit) qui décrit une publication, et
   l'inventaire porte les deux.
9. **`inventaire.json` est servi publiquement** avec le reste de l'arbre. C'est assumé : il ne
   contient que ce qu'un visiteur peut recalculer en téléchargeant les fichiers, plus l'identité du
   commit — déjà publique, le dépôt étant ouvert. Le publier permet à un tiers de vérifier ce qu'il
   a reçu sans nous le demander, ce qui est la propriété recherchée.
10. **Les relevés bruts du spike ne sont pas versionnés.** `reports/` est ignoré par git ; seul
    `docs/spikes/0045/sonde-hebergement.json` est conservé, parce qu'il date des faits mesurés sur
    des services tiers qui changeront. Les relevés de navigateur, eux, se rejouent par commande.

## Conditions de réouverture

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- GitHub Pages, ou un autre hébergement sans en-têtes, devient capable de servir `frame-ancestors`
  et COOP — par configuration, non par `<meta>` ;
- un moteur de la matrice cible cesse d'appliquer COOP `same-origin` comme mesuré, ou l'applique
  d'une façon qui casse un usage du produit ;
- l'ADR 0010 est révisée et l'isolation devient exigée : COEP `require-corp` demanderait alors un
  en-tête au **territoire applicatif**, ce que la présente décision n'a pas prévu ;
- ~~le produit acquiert un besoin de cache qui rend `no-store` intenable, auquel cas la politique de
  cache doit être décidée explicitement plutôt qu'héritée du serveur de test~~ — **advenu** :
  l'[ADR 0023](0023-politique-de-cache-par-nature-d-artefact.md) la décide par nature d'artefact ;
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
