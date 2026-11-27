# RailsBox Vault

**Une application Rails distribuée comme un site web, mais exécutée et possédée localement comme un
logiciel de bureau.**

Vous ouvrez une adresse. Le navigateur télécharge l'application, puis l'exécute lui-même : Linux,
Ruby, Rails et la base de données tournent dans l'onglet. Vos données restent sur votre appareil,
chiffrées. Aucun serveur applicatif ne les reçoit.

> RailsBox Vault est expérimental. Aucune version n'est publiée, et il ne doit protéger aucune
> donnée réelle. Voir [Statut](#statut).

## Comment ça marche

- **Distribution.** L'application est publiée sous forme de fichiers statiques. Le serveur de
  publication distribue le logiciel ; il n'héberge pas vos données.
- **Exécution.** Une machine virtuelle ([v86](https://github.com/copy/v86)) démarre dans le
  navigateur et y fait tourner une vraie application Rails avec SQLite, pas une approximation.
- **Stockage.** Le disque de l'application vit dans le stockage local du navigateur (OPFS), dans un
  volume chiffré et authentifié (AES-256-GCM).
- **Ouverture.** Le coffre s'ouvre par une phrase, par une clé d'accès (WebAuthn) ou par un code de
  récupération généré une seule fois. Un moyen compromis se révoque.
- **Sortie.** Une sauvegarde est un fichier documenté et vérifiable, qui se restaure sur un autre
  appareil ou une autre adresse.
- **Séparation.** Une coquille de confiance tient les clés. L'application s'affiche sur une autre
  origine et ne les voit jamais.

Le détail est dans l'[architecture](docs/architecture.md) et le [modèle de menace](SECURITY.md).

## Statut

État au 26 novembre 2026.

### Ce qui fonctionne

Éprouvé en intégration continue, sous Chromium :

- le parcours complet en neuf étapes : créer un coffre, choisir comment l'ouvrir, confirmer son code
  de récupération, travailler dans l'application, verrouiller et rouvrir, sauvegarder, restaurer
  ailleurs, récupérer par le code, révoquer (ADR 0040) ;
- dans les scénarios mesurés, la note de l'application de référence et sa pièce jointe sont durables
  dès que Rails les acquitte (#209) ;
- la reprise par instantané chiffré, mesurée sur un banc et non par le geste « Verrouiller » de la
  coquille : la page du banc est capturée puis fermée, et un nouveau Worker reprend l'état. Le boot
  complet de reprise prend 0,92 s sur un essai unique sous Chromium, et le p95 est de 0,84 s au
  harnais Node, dix essais sur l'environnement de référence ;
- le démarrage hors connexion, une fois l'application installée (ADR 0046, ADR 0048).

Les mesures et leurs protocoles sont dans les [attributs de qualité](docs/quality-attributes.md).

### Ce qui manque avant un premier usage

Même sur des données non sensibles :

- aucune version n'est publiée, et la chaîne de publication n'a jamais été exercée sur un hébergeur
  réel (#124, #125) ;
- la séance où une personne extérieure au projet suit le parcours sans aide n'a pas encore eu lieu :
  cette preuve manque (#195) ;
- le premier démarrage, à froid, prend environ deux minutes : 82,0 s et 116,6 s sur deux essais sous
  Chromium, et un p95 de 125,9 s au harnais Node, sur l'environnement de référence. Son pic de
  mémoire dépasse la cible (#238) ;
- les écritures d'une application tierce hors de SQLite et d'ActiveStorage ne sont pas couvertes
  (#210).

### Navigateurs

| Navigateur          | État                                                          |
| ------------------- | ------------------------------------------------------------- |
| Chromium            | le parcours aboutit, mesuré en intégration continue           |
| Chrome              | deux parcours réussis en local, hors intégration continue     |
| Edge                | fondé sur Chromium, aucune preuve distincte                   |
| Firefox             | l'application ne démarre pas à l'étape 4 (voir « Prérequis ») |
| Safari              | jamais mesuré sur un vrai Safari (#40)                        |
| Navigateurs mobiles | expérimental                                                  |

Les deux parcours sous Chrome installé datent du 17 septembre 2026 ; leur recette et leur portée
sont dans la [viabilité](docs/viabilite.md). La matrice complète est dans la
[compatibilité](docs/compatibility.md).

### Limites de sécurité à connaître

- un retour arrière complet et cohérent du stockage local ne peut pas être distingué de l'état
  historique authentique qu'il restaure ; il peut notamment réintroduire un moyen révoqué ;
- révoquer un moyen d'ouverture ne rechiffre aucune copie déjà prise du volume et de l'enveloppe ;
- l'instantané de reprise contient la mémoire complète de la machine invitée. Il est chiffré sous
  une clé à usage unique du domaine `instantane`, dérivée de la clé maîtresse du volume, mais il
  survit volontairement au verrouillage afin d'éviter un redémarrage à froid ;
- perdre tous les moyens d'ouverture, code de récupération compris, rend le volume définitivement
  inaccessible : RailsBox Vault ne possède aucun séquestre.

Le détail, les conséquences et les scénarios couverts figurent dans le
[modèle de menace](SECURITY.md). L'usage sur des données sensibles reste fermé par ses conditions.

### Avancement

| Jalon                                      | État                           |
| ------------------------------------------ | ------------------------------ |
| 0 — Fondation vérifiable                   | clos ; reste #40 (Safari réel) |
| 1 — Persistance locale                     | clos                           |
| 2 — Portabilité                            | clos                           |
| 3 — Résilience transactionnelle            | clos                           |
| 4 — Volume chiffré                         | tranches livrées               |
| 5 — Déverrouillage et origine de confiance | clos                           |
| 6 — Échanges chiffrés optionnels           | non commencé                   |

Les travaux en cours portent sur le parcours, l'installation d'une application extérieure, et la
stabilité de l'outillage. La [feuille de route](docs/roadmap.md) fixe les critères de chaque jalon,
et l'[issue #31](https://github.com/pinfada/railsbox-vault/issues/31) suit l'avancement.

## Essayer en local

### Prérequis

- Node 22.13 ou plus récent, jusqu'à Node 24 (champ `engines`) ;
- Docker, pour fabriquer l'image de l'application ;
- un navigateur récent fondé sur Chromium. Chromium est mesuré en intégration continue, Chrome en
  local ; Edge n'a pas de preuve distincte.

Sous Firefox, l'étape 4 du parcours guidé n'aboutit pas dans cette version : la machine virtuelle y
tourne environ six fois plus lentement que sous Chromium, et Rails n'y a jamais répondu (ADR 0038) ;
le parcours le dit avant toute attente et propose Chrome ou Edge.

### Lancer

```sh
npm ci
npm run vm:fetch          # le moteur de machine virtuelle
npm run image:build       # l'image de l'application Rails de référence (quelques minutes)
npm run image:manifest    # son descripteur
```

Puis deux serveurs, dans deux terminaux. Ce sont deux origines : la coquille, et l'origine où
l'application s'affiche.

```sh
node tools/serve.mjs --role shell --host 127.0.0.1 --port 4179 --app-origin http://localhost:4180
node tools/serve.mjs --role app --host localhost --port 4180
```

Ouvrez <http://127.0.0.1:4179/index.html> et suivez les écrans.

### Ce que le parcours demande

- **À la création**, une phrase d'au moins 12 caractères, hors espaces de bord. Choisissez plusieurs
  mots sans lien entre eux, ou un secret généré par votre gestionnaire.
- **À l'étape 3**, votre feuille de récupération s'éprouve en vous en servant : après l'avoir
  recopiée, verrouillez le coffre, puis rouvrez-le avec le code de la feuille. Sur cet appareil,
  c'est la seule fois où le code est demandé. Ensuite, votre phrase suffit, tant que vous ne l'avez
  pas révoquée.
- **À l'étape 4**, le premier démarrage de l'application prend environ deux minutes.
- **À l'étape 7** (restaurer ailleurs), lancez un second couple de serveurs sur les ports 4181 et
  4182 (`--app-origin http://localhost:4182`), ouvrez <http://127.0.0.1:4181/index.html> et
  choisissez « J'ai déjà une sauvegarde ».
- **L'étape 9 est facultative.** « Terminer sans révoquer » finit la visite sans rien retirer.
  Révoquer garde le moyen avec lequel vous venez d'ouvrir et retire tous les autres : ouvert par la
  phrase, c'est votre feuille qui ne servira plus. L'écran dit lesquels avant le geste.

Des étapes 5 à 9, « Revenir à mon application » vous y ramène. Après la dernière étape, l'écran de
l'application porte les gestes de tous les jours : verrouiller, sauvegarder, révoquer.

### À savoir

- **Respectez les hôtes indiqués.** Le serveur refuse les alias, notamment `localhost:4179` pour la
  coquille configurée sur `127.0.0.1`. Seul un alias déclaré au lancement (`--alias localhost`,
  réservé aux épreuves automatiques) est servi.
- **Utilisez un profil de navigateur réservé** pour vos coffres de développement : les cookies sont
  partagés entre les ports d'un même hôte, et d'autres services locaux peuvent utiliser ces hôtes.
- **Changer d'origine change l'espace de stockage.** Exportez une sauvegarde avant de déplacer un
  coffre.
- **Pour repartir de zéro**, effacez les données du site dans les réglages du navigateur. La
  progression du parcours y est retenue dans un petit fichier, qui ne contient jamais le code et ne
  constitue pas une preuve : c'est le coffre lui-même qui retient qu'une feuille l'a ouvert (ADR
  0040).
- **Un coffre créé avant le 13 septembre 2026** par une version de développement est refusé
  (`VAULT_COQUILLE_COFFRE_ANTERIEUR`) et n'est pas migré (ADR 0039) : effacez les données du site et
  recréez-le.
- **`npm run image:manifest` réécrit `tools/build-reference-image/manifest.json`**, un fichier suivi
  par git. Ne le commitez pas, sauf si vous avez changé une entrée de l'image (sources épinglées,
  Dockerfile, application). Sinon : `git restore tools/build-reference-image/manifest.json` (#212).
- `?vue=complete` est un paramètre des épreuves automatiques, pas un chemin du produit.

## Développer

```sh
npm ci
npx playwright install chromium firefox webkit
npm run check:statique    # lint, format et tests unitaires
npm run check             # la suite complète, sans Docker
```

Le projet se développe en TDD, et chaque changement passe par une pull request. Lisez d'abord
[Contribuer](CONTRIBUTING.md), puis [Développement](docs/development.md) et la
[stratégie de test](docs/testing.md).

## Principes

- **Local par défaut** : l'application et ses données fonctionnent sans serveur applicatif.
- **Données possédées par l'utilisateur** : le stockage primaire est local et aucun relais ne doit
  pouvoir lire son contenu.
- **Sortie toujours possible** : un export documenté et restaurable est une fonction fondamentale,
  pas une option de secours.
- **Logiciel reproductible** : un volume identifie la version du runtime et de l'application
  nécessaires pour le rouvrir.
- **Aucun compte central obligatoire** : un service distant peut simplifier la distribution ou
  l'échange, jamais devenir l'autorité sur les données.
- **Rails réel autant que possible** : RailsBox Vault cherche à exécuter l'application Rails et ses
  dépendances, pas à en produire une approximation.

## Relation avec RailsBox Live

[RailsBox Live](https://github.com/pinfada/railsbox) transforme une application Rails en
démonstration publique, isolée et jetable. RailsBox Vault est un projet séparé parce qu'un logiciel
durable contenant des données privées exige un autre contrat produit, un autre modèle de menace et
un autre cycle de publication.

Les deux projets pourront partager ultérieurement des composants dont la frontière aura été
éprouvée. Aucun paquet commun n'est extrait prématurément.

## Documentation

**Comprendre le produit**

- [Vision](docs/vision.md)
- [Exigences produit](docs/product-requirements.md)
- [Architecture exploratoire](docs/architecture.md)
- [Direction visuelle et accessibilité du parcours](docs/direction-visuelle.md)

**Sécurité**

- [Modèle de menace](SECURITY.md)
- [Format de volume, spécification pour la revue externe](docs/format-de-volume-v3.md)

**Qualité**

- [Attributs de qualité](docs/quality-attributes.md)
- [Compatibilité](docs/compatibility.md)
- [Stratégie de test](docs/testing.md)

**Projet**

- [Feuille de route](docs/roadmap.md)
- [Passage du prototype à un produit viable](docs/viabilite.md)
- [Versions et publications](docs/release-policy.md)
- [Gouvernance de développement](docs/governance.md)
- [Contribuer et travailler en TDD](CONTRIBUTING.md)
- [Développement](docs/development.md)
- [Démarrer dans l'équipe](docs/team-start.md)
- [Évaluation de readiness (photographie du 23 août 2026)](docs/readiness-assessment.md)

**Spikes**

- [Spike #35 — protocole et mesures de la topologie d'origine](docs/spikes/0035-topologie-origine-de-confiance.md)
- [Spike #4 — protocole et mesures du backend de blocs v86](docs/spikes/0004-backend-de-blocs-v86.md)
- [Spike #41 — coût mesuré de l'isolation multi-origine sur le runtime v86](docs/spikes/0041-isolation-coop-coep.md)
- [Spike #45 — où publier les deux origines, et comment vérifier ce qui est servi](docs/spikes/0045-chaine-de-publication.md)
- [Spike #46 — ce que deux applications voient l'une de l'autre selon la topologie d'origine](docs/spikes/0046-isolation-entre-applications.md)

### Décisions d'architecture (ADR)

Chaque décision structurante est écrite, datée et numérotée.

<details>
<summary>Les 49 ADR</summary>

- [ADR 0001 — un produit et un dépôt séparés](docs/decisions/0001-produit-et-depot-separes.md)
- [ADR 0002 — la frontière coquille / application est une frontière d'origine](docs/decisions/0002-topologie-origine-de-confiance.md)
- [ADR 0003 — le backend de blocs v86 est un adaptateur et un pont de durabilité](docs/decisions/0003-backend-de-blocs-v86.md)
- [ADR 0004 — SQLite porte l'invariant de l'application de référence](docs/decisions/0004-sqlite-pour-l-application-de-reference.md)
- [ADR 0005 — la reprise se qualifiera par un instantané lié à une génération arrêtée](docs/decisions/0005-qualification-de-la-reprise.md)
- [ADR 0006 — la coquille ne promet jamais une durabilité qu'elle ne tient pas](docs/decisions/0006-conduite-refus-persistance.md)
- [ADR 0007 — le manifeste versionné lie format, runtime, application et géométrie](docs/decisions/0007-manifeste-de-volume.md)
- [ADR 0008 — le format d'archive lie manifeste, contenu et empreinte vérifiable](docs/decisions/0008-format-d-archive-d-export.md)
- [ADR 0009 — la restauration vérifie avant d'écrire et n'identifie le volume qu'après l'avoir relu](docs/decisions/0009-restauration-inter-origine.md)
- [ADR 0010 — la distribution n'impose pas l'isolation multi-origine ; COOP seul reste recommandé](docs/decisions/0010-isolation-multi-origine.md)
- [ADR 0011 — la migration va d'un format au suivant, exige une preuve et reprend depuis son journal](docs/decisions/0011-migration-de-format-et-reprise.md)
- [ADR 0012 — les scénarios de bout en bout s'exécutent sur un OPFS adossé au disque](docs/decisions/0012-support-des-scenarios-de-bout-en-bout.md)
- [ADR 0013 — la CSP de la coquille ne change pas ; v86 bat grâce à une boucle d'ordonnancement fournie par Vault](docs/decisions/0013-csp-de-la-coquille-et-boucle-de-v86.md)
- [ADR 0014 — une génération est validée par une racine d'un secteur alternée, et un volume rouvert présente la dernière génération validée](docs/decisions/0014-generation-transactionnelle.md)
- [ADR 0015 — cinq menaces, cinq propriétés cryptographiques testables ; AES-256-GCM, nonces aléatoires, racine authentifiée](docs/decisions/0015-proprietes-cryptographiques-du-format.md)
- [ADR 0016 — le format de volume v3 range le sceau hors de la charge : en-tête, région d'authentification, sceau de 34 octets](docs/decisions/0016-format-de-volume-v3-dispositions.md)
- [ADR 0017 — la chaîne de publication sert les mêmes en-têtes que le serveur de test, et inventorie ce qu'elle publie](docs/decisions/0017-chaine-de-publication.md)
- [ADR 0018 — le navigateur ne cloisonne le stockage que par origine : une origine par application dès la seconde, MVP mono-application accepté](docs/decisions/0018-isolation-entre-applications.md)
- [ADR 0019 — la racine date la région d'authentification et un témoin voisin date la séquence : le retour arrière partiel est détecté, le complet reste nommé](docs/decisions/0019-fraicheur-du-volume.md)
- [ADR 0020 — l'enveloppe de clé vit hors du volume, en deux pages alternées, et une révocation retire l'emplacement](docs/decisions/0020-enveloppe-de-cle.md)
- [ADR 0021 — une clé de déverrouillage se dérive d'une phrase Argon2id ou d'un PRF WebAuthn, et rien d'autre ne descend d'elle](docs/decisions/0021-derivation-des-cles-de-deverrouillage.md)
- [ADR 0022 — la coquille sert `Referrer-Policy` et `Permissions-Policy` ; HSTS est écarté du code et confié à l'exploitant](docs/decisions/0022-entetes-de-durcissement.md)
- [ADR 0023 — la politique de cache est décidée par nature d'artefact, et une seule dimension varie selon le chemin](docs/decisions/0023-politique-de-cache-par-nature-d-artefact.md)
- [ADR 0024 — l'instantané de reprise est un voisin chiffré lié à une génération validée, et il n'est jamais une source de vérité](docs/decisions/0024-instantane-de-reprise.md)
- [ADR 0025 — un code de récupération est GÉNÉRÉ, rendu une fois, et rien du produit ne le retrouve](docs/decisions/0025-moyen-de-recuperation.md)
- [ADR 0026 — la révocation d'urgence retire tout sauf l'emplacement qui ouvre, et la page libre est effacée](docs/decisions/0026-revocation-d-urgence-et-page-libre.md)
- [ADR 0027 — l'archive emporte une enveloppe de RÉCUPÉRATION SEULE, et la feuille ancre la version](docs/decisions/0027-archive-et-ancre-de-version.md)
- [ADR 0028 — la coquille de produit et sa frontière](docs/decisions/0028-coquille-de-produit-et-frontiere.md)
- [ADR 0029 — le déverrouillage dans la coquille : trois moyens, une attente annoncée, une feuille](docs/decisions/0029-deverrouillage-dans-la-coquille.md)
- [ADR 0030 — le cycle de vie assemblé dans la coquille : l'ordre prouvé par l'échec de son inverse, la mort du Worker, COOP](docs/decisions/0030-cycle-de-vie-assemble-dans-la-coquille.md)
- [ADR 0031 — verrouiller : le Worker meurt, l'instantané survit ; le délai d'inactivité et le rechargement de la coquille](docs/decisions/0031-verrouiller-le-worker-meurt-l-instantane-survit.md)
- [ADR 0032 — les fins d'onglet : ce que le moteur livre, et ce que la coquille en fait ; `pagehide`, le bfcache mesuré et le gel non simulable](docs/decisions/0032-les-fins-d-onglet-ce-que-le-moteur-livre.md)
- [ADR 0033 — la DEK est une clé maîtresse : chaque domaine scelle sous sa propre clé dérivée ; six domaines, deux compteurs, quatre clés à usage unique, format v4](docs/decisions/0033-hierarchie-de-cles-derivees-par-domaine.md)
- [ADR 0034 — l'archive porte un engagement scellé sous la clé du domaine `archive`, et aucun volume légitime n'est sans racine](docs/decisions/0034-archive-authentifiee-et-racine-initiale.md)
- [ADR 0035 — le format de volume v4 : deux compteurs dans la racine, et une migration qui rescelle](docs/decisions/0035-format-de-volume-v4-et-migration.md)
- [ADR 0036 — la page d'enveloppe v2, la clôture du troisième chemin, et un budget enfin exhaustif](docs/decisions/0036-page-d-enveloppe-v2-et-budgets-exhaustifs.md)
- [ADR 0037 — reprendre une installation interrompue : un bouton, une signature, un seul geste](docs/decisions/0037-reprendre-une-installation-interrompue.md)
- [ADR 0038 — servir l'application dans le cadre : un Service Worker sur l'origine applicative, un canal de relais, et une session Rails qui ne quitte jamais le Worker de confiance](docs/decisions/0038-servir-l-application-dans-le-cadre.md)
- [ADR 0039 — sauvegarder, restaurer et révoquer depuis la coquille : un coffre, une identité](docs/decisions/0039-sauvegarder-restaurer-revoquer-depuis-la-coquille.md)
- [ADR 0040 — le parcours est un ordre, pas une décision : neuf étapes, un écran à la fois, des conduites pour une personne](docs/decisions/0040-le-parcours-est-un-ordre-pas-une-decision.md)
- [ADR 0041 — le paquet applicatif : partition 2 d un `hda` composé, données sur hdb, descripteur v2](docs/decisions/0041-le-paquet-applicatif-partition-2-d-un-hda-compose.md)
- [ADR 0042 — le déphasage de versions : la version et le schéma décident avant le boot](docs/decisions/0042-le-dephasage-de-versions-le-schema-decide-avant-le-boot.md)
- [ADR 0043 — l'application d'abord : la promesse à l'entrée, l'application plein écran](docs/decisions/0043-l-application-d-abord.md)
- [ADR 0044 — le magasin d'artefacts : rangé sous l'empreinte, vérifié contre la racine du descripteur, cédant au volume](docs/decisions/0044-le-magasin-d-artefacts.md)
- [ADR 0045 — les workflows de l'image et des épreuves VM restent sur ubuntu-24.04, à titre provisoire](docs/decisions/0045-les-workflows-d-image-restent-sur-ubuntu-24-04.md)
- [ADR 0046 — le descripteur scellé et le démarrage hors connexion : HMAC sous la clé du coffre, « injoignable » = un `TypeError` de `fetch`](docs/decisions/0046-le-descripteur-scelle-et-le-demarrage-hors-connexion.md)
- [ADR 0047 — un rejet « transitoire » du stockage n'est pas une absence : état et refus indéterminés, réessayables](docs/decisions/0047-un-rejet-transitoire-du-stockage-n-est-pas-une-absence.md)
- [ADR 0048 — le Service Worker de la coquille sert la réserve hors connexion : un seul, vérifié avant de servir, borné au bootstrap puis aux clients contrôlés (en vigueur depuis D1h-b, #323)](docs/decisions/0048-le-service-worker-de-la-coquille-sert-la-reserve-hors-connexion.md)
- [ADR 0049 — le modèle d'état de la révocation d'urgence](docs/decisions/0049-le-modele-d-etat-de-la-revocation.md)

</details>

## Licence

RailsBox Vault est distribué sous licence MIT. Voir [LICENSE](LICENSE).
