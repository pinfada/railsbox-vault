// Seuils CALIBRÉS du journal de génération (#16, ADR 0014, #91).
//
// Ils vivent à part de `generation-store.mjs` pour une raison qui n'est pas la taille : ce sont les
// seules valeurs du magasin qu'un relevé peut contredire. Chacune porte la mesure qui la fixe, la
// date de ce relevé et le budget de `docs/quality-attributes.md` qu'elle sert ; les regrouper rend
// visible d'un seul regard ce qu'une nouvelle mesure aurait à réviser.

/**
 * Plafond par défaut de la charge d'un journal, en octets.
 *
 * Il existe parce qu'une génération est bornée par la barrière du GUEST, et que rien n'oblige un
 * guest à en émettre. Sans plafond, un invité qui n'appelle jamais `fsync` ferait grossir le journal
 * jusqu'au quota, et l'échec surviendrait au pire endroit — au milieu d'une validation. Le plafond
 * refuse TÔT, avec un code à lui, plutôt que de publier une génération à moitié.
 *
 * 16 Mio, et ce chiffre est CALIBRÉ depuis #91 — il ne l'était pas. Il valait 64 Mio, « le même
 * ordre de grandeur que la surmémoire de streaming », c'est-à-dire une analogie. Ce qui le fixe
 * désormais est le budget de RÉCUPÉRATION de `docs/quality-attributes.md` : la dernière génération
 * valide doit être retrouvée en ≤ 60 s, et rejouer une charge coûte d'autant plus cher qu'elle est
 * découpée fin — un enregistrement par écriture du guest, et une écriture ATA peut ne faire qu'un
 * secteur. Mesuré sur OPFS réel (`reports/vm/recuperation-generation.json`), à la granularité la
 * plus fine que le guest puisse produire — des enregistrements de 512 octets :
 *
 *  - 64 Mio : **entre 39,4 s et 71,1 s** selon l'état de la machine, sur quatre exécutions du banc.
 *    Des relevés individuels tombent des DEUX côtés des 60 s : la mesure ENCADRE le budget au lieu
 *    de tenir dessous, la marge est nulle, et l'environnement de référence n'est pas la machine qui
 *    a relevé ces chiffres ;
 *  - 16 Mio : **p95 entre 12,4 et 24,7 s**, pire valeur individuelle 27,7 s — un facteur deux sous
 *    le budget dans la plus mauvaise exécution, et la conclusion ne dépend plus de la machine.
 *
 * Le budget n'est pas révisé pour faire tenir le plafond : c'est le plafond qui cède, comme l'exige
 * la règle de #91. Et 16 Mio reste deux fois `POINT_DE_CONTROLE_OCTETS` — un guest qui émet des
 * barrières n'est jamais refusé — et **16,6 fois** la plus grande charge que l'image de référence
 * ait présentée à ce plafond : 1 012 688 octets, boot après migration, relevé de bout en bout du
 * 2026-08-27. Le facteur valait 66 à 64 Mio ; l'abaissement le réduit sans l'annuler, et c'est le
 * prix assumé d'un budget de récupération tenu.
 *
 * Ce que ce chiffre n'est TOUJOURS pas : la plus grande génération que l'image de référence peut
 * produire. Personne ne l'a mesurée ; l'ADR 0014 l'inscrit comme travail découvert.
 */
export const PLAFOND_CHARGE_OCTETS = 16 * 1024 * 1024;

/** Au-delà de ce volume de charge, le point de contrôle est déclenché de lui-même. */
export const POINT_DE_CONTROLE_OCTETS = 8 * 1024 * 1024;

/**
 * Tampon avec lequel une charge est relue, en octets. C'est la SURMÉMOIRE de la récupération.
 *
 * Il est une CONSTANTE, et c'est tout l'intérêt : la plus grande allocation d'une récupération ne
 * suit pas la taille de la charge, donc pas le plafond. Relever `PLAFOND_CHARGE_OCTETS` ne relève
 * pas la surmémoire ; `docs/quality-attributes.md` la borne à 64 Mio pour l'export et la
 * restauration, et la récupération tient désormais le même régime avec deux ordres de grandeur de
 * marge.
 *
 * 1 Mio n'est pas un optimum mesuré : c'est le compromis entre le nombre d'appels au support et la
 * mémoire tenue. `tests/vm/recuperation-generation.spec.mjs` mesure ce que ce choix coûte en temps
 * sur OPFS réel ; le chiffre est publié, pas supposé.
 */
export const TAMPON_RELECTURE_OCTETS = 1024 * 1024;
