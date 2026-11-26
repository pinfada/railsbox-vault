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
   déduit du descripteur et jamais d'un répertoire. Les octets viennent du disque (non versionnés),
   la taille de chaque fichier et l'empreinte du noyau, de l'initrd et des BIOS sont confrontées au
   descripteur. Le mode par défaut ne change pas : `npm run check` garde son budget. La réserve du
   Service Worker n'inclut pas l'image (copiée après elle ; le magasin OPFS la range, ADR 0044).
2. **Limites d'hébergeur par profil** (`tools/publier-limites-hebergeur.mjs`), code de sortie **7**
   de `--verifier --profil`, jugé après les écarts (1), l'épinglage (5) et l'incomplétude (6).
3. **Envoi inerte** (`tools/publier-envoi.mjs`, jobs `repetition` et `deployer` de
   `publication.yml`) : `workflow_dispatch` seul, environnement `production`, secrets absents ⇒
   répétition à blanc, `wrangler` épinglé, dépassement ⇒ refus avant tout appel.
4. **Le découpage des gros artefacts n'est pas décidé ici.** Le descripteur v3 décrit un artefact
   par une URL, une taille et une empreinte (`descripteur-applicatif.mjs`,
   `acquisition-du-disque-systeme.mjs`) ; découper change son format, donc celui du descripteur
   scellé : décision du mainteneur.

## Conséquences et limites

- Tant que la décision 4 n'est pas prise, l'image réelle dépasse 25 Mio et le profil
  `cloudflare-pages` refuse l'envoi (code 7) : c'est voulu, et c'est rapporté par la répétition à
  blanc.
- Non prouvé : un envoi réel, les droits du jeton, Firefox et WebKit sur l'arbre publié seul, la
  vérification d'empreinte du rootfs, du paquet et de la graine par le publieur (elle porte sur
  l'image décompressée ; c'est le navigateur qui la fait, prouvé par l'E2E).
- La fabrication de l'image n'étant pas reproductible, la comparaison d'empreinte de racine de la
  coquille ne vaut que pour un même run ; le retour arrière reste éprouvé sans l'image.
