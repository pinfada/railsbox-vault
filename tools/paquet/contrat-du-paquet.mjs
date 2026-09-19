// CONTRAT du paquet applicatif : ce qu'un paquet DÉCLARE de lui-même (#236, ADR 0041).
//
// Un paquet est fait de deux images et d'un contrat :
//
//   image   le CODE — arbre de l'application, bundle i386 compilé par le Ruby de l'image, cache
//           Bootsnap chaud. ext4 SANS journal, marge réduite : il est monté en lecture-écriture
//           éphémère (partition 2 de `hda`), ses écritures vivent en RAM et meurent au boot à froid,
//           et son journal ne servirait donc jamais.
//   graine  les DONNÉES à la naissance — base SQLite migrée et vide, `storage/` vide, marqueur de
//           schéma. ext4 JOURNALISÉ, taille fixe : c'est le volume `application` du coffre, celui
//           dont #209 exige la durabilité.
//   contrat ce fichier : identité, schéma, empreintes, exigences, dérivation du `secret_key_base`.
//
// Ce module ne lit ni n'écrit aucun fichier : il construit un objet et le valide. C'est ce qui le
// rend mesurable sans Docker — un validateur qu'on n'a jamais vu dire « non » ne prouve rien.

/** Version du contrat. Un lecteur d'une autre version refuse plutôt que de deviner. */
export const VERSION_CONTRAT_PAQUET = 1;

/** Empreinte SHA-256 en hexadécimal minuscule. */
const EMPREINTE = /^[0-9a-f]{64}$/;

/** @typedef {{ code: string, message: string }} Anomalie */

/**
 * Le NOM d'une image de paquet : l'identité, la version, puis le début de l'empreinte.
 *
 * L'empreinte dans le nom n'est pas une décoration : les artefacts sont servis sous un cache
 * IMMUABLE (ADR 0023), et deux versions d'un même paquet qui porteraient le même nom se
 * remplaceraient dans le cache d'un visiteur sans qu'aucune requête ne reparte.
 *
 * @param {{ id: string, version: string, sha256: string, suffixe?: string }} parties
 */
export function nomDImage({ id, version, sha256, suffixe = "" }) {
  const empreinte = sha256.slice(0, 8);
  return `${id}-${version}${suffixe === "" ? "" : `-${suffixe}`}-${empreinte}.ext4`;
}

/**
 * CONSTRUIT le contrat. Les empreintes et les tailles viennent des fichiers déjà fabriqués : ce
 * module ne les calcule pas, il les range.
 *
 * @param {{
 *   application: { id: string, version: string, schema: string },
 *   image: { name?: string, byteSize: number, sha256: string, servi: object },
 *   graine: { name?: string, byteSize: number, sha256: string, disqueOctets: number,
 *             servi: object },
 *   exigences: { ruby: string, rails: string, debianSuite: string },
 *   secretKeyBase: { derivation: string },
 *   licence: string,
 *   genereLe: string,
 * }} entrees
 */
export function construirePaquet({
  application,
  image,
  graine,
  exigences,
  secretKeyBase,
  licence,
  genereLe,
}) {
  const { id, version } = application;
  return {
    contractVersion: VERSION_CONTRAT_PAQUET,
    generatedAt: genereLe,
    application: { id, version, schema: application.schema },
    image: {
      name: image.name ?? nomDImage({ id, version, sha256: image.sha256 }),
      byteSize: image.byteSize,
      sha256: image.sha256,
      servi: image.servi,
    },
    graine: {
      name: graine.name ?? nomDImage({ id, version, sha256: graine.sha256, suffixe: "graine" }),
      byteSize: graine.byteSize,
      sha256: graine.sha256,
      disqueOctets: graine.disqueOctets,
      servi: graine.servi,
    },
    exigences: {
      ruby: exigences.ruby,
      rails: exigences.rails,
      debianSuite: exigences.debianSuite,
    },
    secretKeyBase: { derivation: secretKeyBase.derivation },
    licence,
  };
}

/** @param {unknown} valeur */
function estTaille(valeur) {
  return Number.isInteger(valeur) && valeur > 0;
}

/**
 * VALIDE une image déclarée (le code ou la graine) : nom, taille, empreinte.
 *
 * @param {unknown} partie
 * @param {string} cle
 * @param {(code: string, message: string) => void} ajouter
 */
function validerImage(partie, cle, ajouter) {
  const code = `${cle}-invalide`;
  if (typeof partie !== "object" || partie === null) {
    ajouter(code, `${cle} absent`);
    return;
  }
  if (typeof partie.name !== "string" || partie.name.length === 0) {
    ajouter(code, `${cle}.name absent`);
  }
  if (!estTaille(partie.byteSize)) ajouter(code, `${cle}.byteSize absent ou nul`);
  if (!EMPREINTE.test(partie.sha256 ?? "")) ajouter(code, `${cle}.sha256 absent ou mal formé`);
  validerServi(partie.servi, cle, ajouter);
}

/**
 * VALIDE le fichier SERVI d'une image (#236 T2) : l'image compressée en gzip, sous un nom qui porte
 * l'empreinte de l'image DÉCOMPRESSÉE. Sa taille et son empreinte sont celles du fichier compressé,
 * c'est-à-dire de ce qui voyage.
 */
function validerServi(servi, cle, ajouter) {
  const code = `${cle}-invalide`;
  if (typeof servi !== "object" || servi === null) {
    ajouter(code, `${cle}.servi absent : l'image n'a pas été compressée pour être servie`);
    return;
  }
  if (servi.compression !== "gzip") ajouter(code, `${cle}.servi.compression n'est pas « gzip »`);
  if (typeof servi.name !== "string" || !servi.name.endsWith(".gz")) {
    ajouter(code, `${cle}.servi.name absent ou sans « .gz »`);
  }
  if (!estTaille(servi.byteSize)) ajouter(code, `${cle}.servi.byteSize absent ou nul`);
  if (!EMPREINTE.test(servi.sha256 ?? "")) {
    ajouter(code, `${cle}.servi.sha256 absent ou mal formé`);
  }
}

/**
 * VALIDE un contrat de paquet, champ par champ, et rend la liste de ce qui manque.
 *
 * @param {unknown} paquet
 * @returns {Anomalie[]}
 */
export function validerPaquet(paquet) {
  /** @type {Anomalie[]} */
  const anomalies = [];
  const ajouter = (code, message) => anomalies.push({ code, message });

  if (typeof paquet !== "object" || paquet === null) {
    ajouter("paquet-invalide", "le paquet n'est pas un objet");
    return anomalies;
  }
  if (paquet.contractVersion !== VERSION_CONTRAT_PAQUET) {
    ajouter(
      "contrat-inconnu",
      `contractVersion ${JSON.stringify(paquet.contractVersion)} au lieu de ${VERSION_CONTRAT_PAQUET}`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(paquet.generatedAt ?? "")) {
    ajouter("horodatage-absent", "generatedAt absent ou mal formé");
  }
  for (const champ of ["id", "version", "schema"]) {
    if (!paquet.application?.[champ]) {
      ajouter("application-incomplete", `application.${champ} absent`);
    }
  }
  validerImage(paquet.image, "image", ajouter);
  validerImage(paquet.graine, "graine", ajouter);
  if (!estTaille(paquet.graine?.disqueOctets)) {
    ajouter("graine-invalide", "graine.disqueOctets absent ou nul");
  }
  for (const champ of ["ruby", "rails", "debianSuite"]) {
    if (!paquet.exigences?.[champ]) {
      ajouter("exigences-incompletes", `exigences.${champ} absent`);
    }
  }
  if (!paquet.secretKeyBase?.derivation) {
    ajouter("derivation-absente", "secretKeyBase.derivation absent");
  }
  if (!paquet.licence) ajouter("licence-absente", "licence absente");
  return anomalies;
}
