# ADR 0044 — Le magasin d'artefacts

- Statut : accepté
- Date : 2026-10-04
- Complète : l'ADR 0006 (le volume a la priorité), l'ADR 0023 (cache par nature d'artefact), l'ADR
  0041 (le disque composé) et l'ADR 0042 (mise à jour décidée avant le boot)
- Issues : #247 (lot D1, `lot:artefacts`), #124 ; ferme #151 sans objet

## Contexte

Chaque démarrage retéléchargeait le rootfs et le paquet applicatif (177 Mio mesurés au lot D-0,
`docs/mesures/2026-10-lot-d-reference.md`), si bien que la réouverture d'un coffre coûtait 18 à 36 s
de transfert et ne pouvait pas avoir lieu sans réseau. Le défi C-K du lot D (rapport rendu sur #247,
run 4fb3, veille de l'état de l'art datée et sourcée) a conclu à un magasin OPFS rangé par artefact,
vérifié contre le descripteur, et qui cède toujours au volume. La DoR de #247 a été gelée sur ces
décisions.

## Décisions

1. **Rangement par artefact, sous son empreinte, jamais le disque composé.** Le magasin
   (`vault-artefacts/` de l'origine de confiance) range `<sha256>` et `<sha256>.tranches`. Le disque
   système reste une COMPOSITION calculée à chaque démarrage (ADR 0041) : ranger le disque composé
   lierait le cache à une table de partitions, et le guest écrit dans ce tampon.
2. **Tranches de 8 Mio, racine portée par le DESCRIPTEUR.** Un artefact est découpé en tranches de 8
   Mio ; leur liste d'empreintes forme une racine que `image:manifest` inscrit dans le descripteur
   (`racine`). Le magasin vérifie ce qu'il sert contre la racine du DESCRIPTEUR, jamais contre la
   liste qu'il a rangée lui-même : une liste altérée dans l'OPFS ne fait pas foi. Sans racine au
   descripteur, l'artefact est vérifié en entier (chemin lent, mais même garantie).
3. **Aucun octet servi avant vérification, aucun partiel servi.** Une admission écrit sous un nom
   provisoire puis renomme ; une lecture qui échoue, qui est altérée ou qui dépasse **20 s**
   (`DELAI_DU_MAGASIN_MS`) rend « absent » et le démarrage retombe sur le téléchargement.
4. **Un cache qui cède toujours au volume.** Une admission n'a lieu que si le budget de stockage
   laisse 256 Mio au volume (`MARGE_RESERVEE_AU_VOLUME`) ; une estimation indisponible refuse. Une
   réservation du volume qui manquerait de place purge d'abord le magasin, y compris avant la
   CRÉATION d'un volume. Une purge refusée est comptée et signalée
   (`VAULT-ARTEFACTS-PURGE-ECHOUEE`), jamais transformée en panne.
5. **Rétention.** Après une acquisition réussie, le magasin garde le rootfs courant, le paquet
   courant et le paquet précédent (ADR 0042 § 4), et oublie le reste. Le journal de rétention ne
   juge rien : altéré, il coûte au pire un téléchargement.
6. **Hors ligne : seulement si l'origine est INJOIGNABLE.** Le dernier descripteur vérifié est rangé
   au magasin. Il ne fait foi que si `fetch` LÈVE (échec réseau). Si l'origine répond autre chose —
   refus, erreur HTTP, descripteur différent —, la décision de l'ADR 0042 s'applique telle quelle :
   l'origine fait foi. La coquille dit alors à la personne qu'elle travaille hors connexion, avec la
   version de telle date. C'est un gel de version (« freeze » au sens de TUF), accepté par
   l'amendement du 04/10 de l'ADR 0042 tant que les paquets ne sont pas signés.
7. **Lecture groupée (lot D2), décision du 04/10.** La lecture par tranches à la demande est
   reportée au lot D2 ; D1 lit l'artefact entier depuis le magasin, en une passe vérifiée.

## État au 04/10/2026

Les décisions 1 à 5 sont en service (D1a, D1b, D1c). La décision 6 (hors ligne) est arrêtée mais pas
encore implémentée : tant qu'elle ne l'est pas, une origine injoignable empêche le démarrage, comme
avant le magasin. La campagne de mutation `magasin` reste à écrire.

## Conséquences

- La réouverture d'un coffre ne transfère plus le rootfs ni le paquet
  (`tests/e2e/magasin-d-artefacts.spec.mjs`) ; un magasin vidé n'empêche rien.
- **#151 est fermée sans objet** : le cas résiduel qu'elle gardait (un Service Worker qui rendrait
  un artefact pour une autre clé) n'existe pas, le magasin étant indexé par l'empreinte vérifiée et
  aucun Service Worker n'étant installé sur l'origine.
- Ce que le magasin protège et ne protège pas est décrit dans `SECURITY.md` § « Le magasin
  d'artefacts ».
- Les gardes ci-dessus sont mutées par la campagne `magasin` de `tools/rejouer-les-campagnes.mjs`.

## Renvois

- Rapport du défi C-K du lot D : commentaire sur #247 (run 4fb3, 20/09/2026).
- Mesures de référence : `docs/mesures/2026-10-lot-d-reference.md` ; mesures de sortie :
  `docs/quality-attributes.md`.
