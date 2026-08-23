// Contrat d'épinglage de la chaîne de construction de l'image de référence.
//
// Ce module ne lit aucun fichier : il analyse des textes. C'est ce qui permet à
// `tests/unit/build-pinning.test.mjs` de lui présenter des Dockerfiles fautifs
// et de vérifier qu'il les refuse — un vérificateur qu'on n'a jamais vu dire
// « non » ne prouve rien.
//
// Deux exigences, énoncées par l'issue #5 : la construction échoue si un
// artefact n'est pas épinglé, et elle échoue si un secret est requis.

/** Empreinte d'image : `sha256:` suivi de 64 caractères hexadécimaux. */
const DIGEST = /@sha256:[0-9a-f]{64}(?:\s|$)/;

/** Noms de variables qui trahissent un secret attendu au moment de la construction. */
const NOMS_SENSIBLES =
  /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_?KEY|ACCESS_KEY|MASTER_KEY)/i;

/** Fichiers de secret Rails qui ne doivent jamais entrer dans une image. */
const FICHIERS_SENSIBLES = /(master\.key|credentials\.yml\.enc|\.env\b|id_rsa|\.pem\b)/i;

/** Téléchargements distants : chacun doit être suivi d'une vérification d'empreinte. */
const TELECHARGEMENT = /\b(?:curl|wget)\b[^\n]*\bhttps?:\/\//;

/**
 * @typedef {{ code: string, message: string, ligne: number }} Anomalie
 */

/**
 * Réunit les lignes d'une instruction Dockerfile continuée par `\`.
 *
 * @param {string} texte
 * @returns {{ numero: number, contenu: string }[]}
 */
export function instructionsDockerfile(texte) {
  const lignes = texte.split(/\r?\n/);
  const instructions = [];
  let courante = null;

  for (const [index, brute] of lignes.entries()) {
    const ligne = brute.replace(/\s+$/, "");
    const sansCommentaire = /^\s*#/.test(ligne);
    if (courante === null && (sansCommentaire || ligne.trim() === "")) continue;

    if (courante === null) {
      courante = { numero: index + 1, contenu: "" };
    }
    const continuee = ligne.endsWith("\\");
    courante.contenu +=
      (courante.contenu === "" ? "" : "\n") + (continuee ? ligne.slice(0, -1) : ligne);
    if (!continuee) {
      instructions.push(courante);
      courante = null;
    }
  }
  if (courante !== null) instructions.push(courante);
  return instructions;
}

/**
 * Analyse un Dockerfile.
 *
 * @param {string} texte contenu du Dockerfile
 * @param {{ digestsConnus?: string[] }} [options] empreintes déclarées dans `sources.json`
 * @returns {Anomalie[]}
 */
export function analyserDockerfile(texte, options = {}) {
  const digestsConnus = new Set(options.digestsConnus ?? []);
  const anomalies = [];
  const etages = new Set();

  for (const { numero, contenu } of instructionsDockerfile(texte)) {
    const aplati = contenu.replace(/\n/g, " ");
    const from = aplati.match(/^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      const [, reference, etage] = from;
      if (!etages.has(reference)) {
        if (!DIGEST.test(`${reference} `)) {
          anomalies.push({
            code: "from-non-epingle",
            ligne: numero,
            message: `FROM ${reference} n'est pas épinglé par empreinte (@sha256:…)`,
          });
        } else {
          const empreinte = reference.slice(reference.indexOf("@") + 1);
          if (digestsConnus.size > 0 && !digestsConnus.has(empreinte)) {
            anomalies.push({
              code: "from-hors-sources",
              ligne: numero,
              message: `l'empreinte ${empreinte} n'est pas déclarée dans sources.json`,
            });
          }
        }
      }
      if (etage) etages.add(etage);
      continue;
    }

    const declaration = aplati.match(/^\s*(ARG|ENV)\s+(.*)$/i);
    if (declaration) {
      const noms = declaration[2].match(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*=?/g) ?? [];
      for (const brut of noms) {
        const nom = brut.trim().replace(/=$/, "");
        if (NOMS_SENSIBLES.test(nom)) {
          anomalies.push({
            code: "secret-exige",
            ligne: numero,
            message: `${declaration[1].toUpperCase()} ${nom} exige un secret au moment de la construction`,
          });
        }
      }
    }

    if (/--mount=type=secret/.test(aplati)) {
      anomalies.push({
        code: "secret-exige",
        ligne: numero,
        message: "montage de secret BuildKit : la construction ne doit exiger aucun secret",
      });
    }

    if (/^\s*(COPY|ADD)\s/i.test(aplati) && FICHIERS_SENSIBLES.test(aplati)) {
      anomalies.push({
        code: "secret-copie",
        ligne: numero,
        message: "copie d'un fichier de secret dans l'image",
      });
    }

    if (/^\s*ADD\s+https?:\/\//i.test(aplati)) {
      anomalies.push({
        code: "telechargement-non-verifie",
        ligne: numero,
        message:
          "ADD depuis une URL : aucune empreinte n'est vérifiable, utiliser curl + sha256sum",
      });
    }

    if (TELECHARGEMENT.test(aplati) && !/sha256sum\s+-c/.test(aplati)) {
      anomalies.push({
        code: "telechargement-non-verifie",
        ligne: numero,
        message: "téléchargement distant sans `sha256sum -c` dans la même instruction",
      });
    }
  }

  return anomalies;
}

/**
 * Analyse le fichier de sources : c'est lui qui fait autorité sur les versions.
 *
 * @param {unknown} sources
 * @returns {Anomalie[]}
 */
export function analyserSources(sources) {
  const anomalies = [];
  const ajouter = (code, message) => anomalies.push({ code, message, ligne: 0 });

  if (typeof sources !== "object" || sources === null) {
    ajouter("sources-invalides", "sources.json n'est pas un objet");
    return anomalies;
  }
  const donnees = /** @type {Record<string, any>} */ (sources);

  const images = donnees.images ?? {};
  if (Object.keys(images).length === 0) {
    ajouter("sources-invalides", "aucune image déclarée dans sources.json");
  }
  for (const [nom, image] of Object.entries(images)) {
    if (!/^sha256:[0-9a-f]{64}$/.test(image?.digest ?? "")) {
      ajouter("image-non-epinglee", `images.${nom}.digest absent ou mal formé`);
    }
    if (!image?.reference) ajouter("image-non-epinglee", `images.${nom}.reference absente`);
    if (!image?.license) ajouter("licence-absente", `images.${nom}.license absente`);
  }

  if (!/^[0-9a-f]{64}$/.test(donnees.ruby?.sha256 ?? "")) {
    ajouter("source-non-epinglee", "ruby.sha256 absent ou mal formé");
  }
  if (!donnees.ruby?.version) ajouter("source-non-epinglee", "ruby.version absente");

  const fichiers = donnees.firmware?.files ?? [];
  if (!/^[0-9a-f]{40}$/.test(donnees.firmware?.commit ?? "")) {
    ajouter("source-non-epinglee", "firmware.commit absent ou mal formé");
  }
  if (fichiers.length === 0) ajouter("source-non-epinglee", "aucun micrologiciel déclaré");
  for (const fichier of fichiers) {
    if (!/^[0-9a-f]{64}$/.test(fichier?.sha256 ?? "")) {
      ajouter("source-non-epinglee", `firmware ${fichier?.name}: sha256 absent ou mal formé`);
    }
    if (!fichier?.license) ajouter("licence-absente", `firmware ${fichier?.name}: license absente`);
    if (!/^https:\/\//.test(fichier?.url ?? "")) {
      ajouter("source-non-epinglee", `firmware ${fichier?.name}: url absente ou non https`);
    }
  }

  return anomalies;
}

/**
 * Empreintes d'images déclarées dans `sources.json`, sans le préfixe `@`.
 *
 * @param {unknown} sources
 * @returns {string[]}
 */
export function digestsDeclares(sources) {
  const images = /** @type {Record<string, any>} */ (sources ?? {})?.images ?? {};
  return Object.values(images)
    .map((image) => image?.digest)
    .filter((digest) => typeof digest === "string");
}
