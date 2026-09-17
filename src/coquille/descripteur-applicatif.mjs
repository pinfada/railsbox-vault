// Le DESCRIPTEUR APPLICATIF servi par l'origine de confiance : sa LECTURE et sa FORME (#236).
//
// Scindé de `application-de-reference.mjs` quand le descripteur est passé en v2 (ADR 0041) : ce
// module ne connaît ni volume, ni clé, ni boot — il lit un document servi et dit, champ par champ,
// ce qui l'empêche d'être admis. C'est la frontière que la revue de la PR #171 (constat 11) a
// demandée : une donnée qui traverse une frontière se contrôle à l'entrée, et ce contrôle se relit
// mieux d'un seul bloc que dispersé dans le chemin de démarrage.

/**
 * Où l'origine de CONFIANCE sert le descripteur de son application.
 *
 * Il est écrit par `tools/build-reference-image/manifest.mjs`, dérivé du manifeste d'image, et il ne
 * porte que du public : des noms d'artefacts, des tailles, une ligne de commande. La coquille ne
 * peut pas lire `tools/` — son origine ne sert que `public/`, `src/`, `vendor/` et `artifacts/` —,
 * et le lui faire passer par un paramètre d'URL rouvrirait exactement la porte que #162 a fermée.
 */
export const ADRESSE_DESCRIPTEUR = "/artifacts/application.json";

/**
 * Version de descripteur que ce module sait lire. Une autre est refusée, jamais devinée.
 *
 * **v2 depuis #236 (ADR 0041), et la v1 n'est PAS portée.** La v1 décrivait UN disque — code et
 * données mêlés — par son nom et sa taille, sans empreinte. La v2 décrit trois morceaux (`rootfs`,
 * `paquet`, `graine`), chacun avec la sienne. Accepter les deux formes reviendrait à garder un
 * chemin d'installation qui ne vérifie aucune empreinte, pour des déploiements qui n'existent pas :
 * aucune origine ne sert encore ce produit.
 */
export const DESCRIPTEUR_VERSION_ATTENDUE = 2;

/**
 * Le NOM d'un artefact servi : une lettre ou un chiffre, puis des caractères de nom de fichier.
 *
 * Il entre dans une URL que le Worker de confiance va chercher. La CSP `connect-src 'self'` est la
 * SECONDE barrière — elle refuserait une origine étrangère —, mais une garde qui n'existe que dans
 * l'en-tête n'est pas une garde du produit : un nom porteur de `..` ou d'une barre oblique ferait
 * sortir la requête de son préfixe sans que la politique y voie quoi que ce soit.
 */
const NOM_DARTEFACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Le PRÉFIXE servi : un chemin absolu, sans remontée, sans schéma, sans autorité. */
const PREFIXE_SERVI = /^\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}\/$/;

/**
 * La LIGNE DE COMMANDE du guest, sur un alphabet clos et bornée.
 *
 * Elle est passée telle quelle à l'émulateur, qui la donne au noyau. Elle ne peut donc pas être
 * libre : ce qu'un descripteur y glisserait, c'est un `init=` de son choix.
 */
const LIGNE_DE_COMMANDE = /^[A-Za-z0-9 ._:/=,+-]{1,512}$/;

/** Bornes des deux grandeurs. Elles sont larges, et leur seul rôle est de refuser l'absurde. */
const TAILLE_DISQUE_MAX = 8 * 1024 * 1024 * 1024;
const MEMOIRE_MAX = 4 * 1024 * 1024 * 1024;

/** @param {unknown} valeur @param {number} plafond */
function entierBorne(valeur, plafond) {
  return Number.isInteger(valeur) && valeur > 0 && valeur <= plafond;
}

/**
 * CONTRÔLE la forme d'un descripteur, champ par champ.
 *
 * La version seule ne suffit pas, et c'est le constat 11 de la revue de sécurité de la PR #171 : un
 * descripteur d'une version connue mais aux champs libres fournit six URL, une ligne de commande de
 * noyau et deux grandeurs d'allocation au Worker de confiance. Le descripteur est servi par
 * l'origine de confiance elle-même — ce n'est pas l'adversaire de `SEC-ORIGIN-001` — mais une
 * donnée qui traverse une frontière se contrôle à l'entrée, pas à la source.
 *
 * Rend un MOTIF plutôt qu'un booléen : l'appelant le publie, et « descripteur refusé » sans dire
 * quel champ enverrait chercher au mauvais endroit.
 *
 * @param {unknown} descripteur
 * @returns {{ valide: boolean, motif: string | null }}
 */
export function formeDuDescripteur(descripteur) {
  const refus = (motif) => ({ valide: false, motif });
  if (typeof descripteur !== "object" || descripteur === null)
    return refus("descripteur illisible");
  if (descripteur.descripteurVersion !== DESCRIPTEUR_VERSION_ATTENDUE) {
    return refus(`version de descripteur inconnue : ${String(descripteur.descripteurVersion)}`);
  }
  if (typeof descripteur.application?.id !== "string" || descripteur.application.id.length === 0) {
    return refus("identité d'application absente");
  }
  if (typeof descripteur.runtime?.version !== "string") return refus("version de runtime absente");
  if (!PREFIXE_SERVI.test(String(descripteur.prefixeDesArtefacts ?? ""))) {
    return refus("préfixe d'artefacts hors du chemin servi");
  }
  if (String(descripteur.prefixeDesArtefacts).includes("..")) {
    return refus("préfixe d'artefacts porteur d'une remontée");
  }
  const morceau = formeDesMorceaux(descripteur);
  if (morceau !== null) return refus(morceau);
  if (!entierBorne(descripteur.boot?.memoireOctets, MEMOIRE_MAX)) {
    return refus("mémoire du guest hors bornes");
  }
  if (!LIGNE_DE_COMMANDE.test(String(descripteur.boot?.cmdline ?? ""))) {
    return refus("ligne de commande du guest refusée");
  }
  for (const cle of ["kernel", "initrd", "bios", "vgaBios"]) {
    if (!NOM_DARTEFACT.test(String(descripteur.boot?.[cle] ?? ""))) {
      return refus(`nom d'artefact refusé : ${cle}`);
    }
  }
  return { valide: true, motif: null };
}

/** Une EMPREINTE SHA-256, en hexadécimal minuscule. Sans elle, un morceau n'est pas vérifiable. */
const EMPREINTE = /^[0-9a-f]{64}$/;

/**
 * CONTRÔLE les trois morceaux du paquet : le `rootfs` et le `paquet`, que la coquille range dans le
 * disque composé, et la `graine`, qu'elle verse dans le volume de données.
 *
 * Chacun porte un nom d'artefact, une taille bornée et une EMPREINTE. C'est la différence de fond
 * avec la v1 : ce que l'installation écrit et ce que le guest boote sont désormais confrontés aux
 * octets reçus, pas seulement comptés.
 *
 * Rend le MOTIF du premier manque, ou `null`.
 *
 * @param {Record<string, any>} descripteur
 * @returns {string | null}
 */
function formeDesMorceaux(descripteur) {
  for (const cle of ["rootfs", "paquet", "graine"]) {
    const morceau = descripteur[cle];
    if (!NOM_DARTEFACT.test(String(morceau?.nom ?? ""))) return `nom d'artefact refusé : ${cle}`;
    if (!entierBorne(morceau?.octets, TAILLE_DISQUE_MAX)) return `taille hors bornes : ${cle}`;
    if (!EMPREINTE.test(String(morceau?.sha256 ?? "")))
      return `empreinte absente ou mal formée : ${cle}`;
  }
  if (!entierBorne(descripteur.graine?.disqueOctets, TAILLE_DISQUE_MAX)) {
    return "taille du disque de données hors bornes";
  }
  return null;
}

/**
 * LIT le descripteur servi, ou dit ce qui manque.
 *
 * L'absence n'est PAS une erreur : `npm run check` tourne sans les artefacts de l'image de
 * référence, et la coquille doit alors se déclarer sans application plutôt qu'échouer. C'est la même
 * règle que l'état `indisponible` — nommer l'absence au lieu de la traiter comme une panne.
 *
 * @param {{ recuperer?: typeof fetch }} [options]
 * @returns {Promise<{ present: boolean, descripteur?: object, motif?: string }>}
 */
export async function lireLeDescripteur({ recuperer = globalThis.fetch } = {}) {
  let reponse;
  try {
    reponse = await recuperer(ADRESSE_DESCRIPTEUR, { cache: "no-store" });
  } catch (erreur) {
    return { present: false, motif: `descripteur inatteignable : ${erreur.message}` };
  }
  if (!reponse.ok) {
    return { present: false, motif: `aucun descripteur servi (${reponse.status})` };
  }
  let descripteur;
  try {
    descripteur = await reponse.json();
  } catch {
    return { present: false, motif: "descripteur illisible" };
  }
  const forme = formeDuDescripteur(descripteur);
  if (!forme.valide) return { present: false, motif: forme.motif };
  return { present: true, descripteur };
}
