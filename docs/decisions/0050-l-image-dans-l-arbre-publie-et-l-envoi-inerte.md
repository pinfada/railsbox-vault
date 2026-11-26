# ADR 0050 — L'image dans l'arbre publié, les limites de l'hébergeur et l'envoi inerte

- Statut : proposé (relecture indépendante demandée)
- Date : 2026-11-26
- Issue : [#45](https://github.com/pinfada/railsbox-vault/issues/45) · étape 3 de l'objectif du
  26/11 (#31) · amende l'ADR 0030 § Limites et l'ADR 0017 § 8
- Ne change : ni le format du descripteur (ADR 0046), ni un format persistant, ni la frontière de
  confiance.

## Contexte

L'ADR 0030 avait décidé de ne **pas** publier les artefacts de l'image (plus de 200 Mio) : « une
obligation d'exploitant ». Constat du 26/11 : la publication ne démarre donc pas, et aucune épreuve
ne le montrait — `tests/e2e/hors-ligne.spec.mjs` sert `/artifacts/` depuis le dossier local. L'ADR
0017 § 8 laissait l'envoi à écrire.

## Décisions

1. **`--avec-image`** (`tools/publier-image.mjs`) publie le descripteur et **ce qu'il nomme**,
   déduit du descripteur et jamais d'un répertoire. Les octets viennent du disque (non versionnés).
   **Avant de publier**, le publieur vérifie l'identité de chaque fichier : sa taille servie ;
   l'empreinte du noyau, de l'initrd et des deux BIOS ; et l'empreinte **décompressée** (recalculée
   en flux) du rootfs, du paquet, de la graine et du paquet précédent. Une altération de même taille
   est refusée (code 4). Des déclarations **contradictoires** (même nom, tailles ou empreintes
   différentes) sont refusées par le publieur, même si `descripteur-applicatif.mjs` les accepte : un
   nom désigne un seul fichier. Le mode par défaut ne change pas : `npm run check` garde son budget.
   La réserve du Service Worker n'inclut pas l'image (copiée après elle ; le magasin OPFS la range,
   ADR 0044).
2. **Limites d'hébergeur par profil** (`tools/publier-limites-hebergeur.mjs`), code de sortie **7**
   de `--verifier --profil`, jugé après les écarts (1), l'épinglage (5) et l'incomplétude (6). Le
   profil `netlify` y est informatif.
3. **Envoi inerte** (`tools/publier-envoi.mjs`, jobs `repetition` et `deployer` de
   `publication.yml`) : `workflow_dispatch` seul, `wrangler` épinglé par version, secrets absents ⇒
   répétition à blanc. Le profil d'envoi est `cloudflare-pages` seul. Les DEUX arbres et leurs
   projets sont contrôlés avant le premier envoi (un seul appel d'outil) : un dépassement ou un nom
   invalide donne zéro appel.
4. **La protection humaine est vérifiée, pas supposée.** `environment: production` ne protège rien
   en soi : GitHub crée un environnement absent, sans règle. Le job `deployer` exécute, avant
   l'étape qui reçoit les secrets, `tools/publier-garde-environnement.mjs`, qui exige (a) un
   relecteur requis dans la configuration de l'environnement ET (b) une approbation `approved` pour
   `production` dans `GET /actions/runs/{run_id}/approvals` **de ce run** (une règle ajoutée après
   le démarrage du job satisfait (a) sans que ce run ait attendu quiconque). `contents: read` suffit
   aux deux lectures (mesuré le 26/11/2026) : aucune permission de plus. La garde échoue fermée.
5. **Le découpage des gros artefacts n'est pas décidé ici.** Le descripteur v3 décrit un artefact
   par une URL, une taille et une empreinte (`descripteur-applicatif.mjs`,
   `acquisition-du-disque-systeme.mjs`) ; découper change son format, donc celui du descripteur
   scellé : décision du mainteneur (#334).

## Conséquences et limites

- Tant que la décision 5 n'est pas prise, l'image réelle dépasse 25 Mio (trois fichiers : rootfs,
  paquet courant, paquet précédent) et le profil `cloudflare-pages` refuse l'envoi (code 7) : c'est
  voulu, et c'est rapporté par la répétition à blanc.
- **Non prouvé** : un envoi réel ; les droits du jeton ; Firefox et WebKit sur l'arbre publié seul ;
  la **forme** des réponses de l'API pour un environnement protégé réel et pour une approbation
  réelle (la sonde n'a rendu que `[]` : la forme lue est celle de la documentation) ; la limitation
  des secrets à l'environnement et l'absence d'un secret de dépôt du même nom (le jeton du workflow
  ne lit pas les secrets : vérification manuelle, `docs/release-policy.md`).
- La fabrication de l'image n'étant pas reproductible, la comparaison d'empreinte de racine de la
  coquille ne vaut que pour un même run ; le retour arrière reste éprouvé sans l'image (#336).
