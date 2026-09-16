// Prépare une migration d'identité sur une COPIE, sans modifier ni supprimer la source.
// Les backends authentifient le clair sous leurs identités respectives. Ce module ne chiffre
// rien lui-même et ne publie aucun manifeste : « copie vérifiée » n'est pas « coffre migré ».
// L'appelant garde les deux volumes exclusifs et la source figée pendant toute l'opération.
import { SECTOR_SIZE } from "./block-geometry.mjs";
import { MigrationError, MIGRATION_ERROR_CODES } from "./migration-errors.mjs";
import { creerCederLaMain } from "./ceder-la-main.mjs";

export const BLOC_DE_COPIE_MIGRATION = 1024 * 1024;
const MAX_JOURNAL = 4096;
const IDENTIFIANT = /^[0-9a-f]{32}$/;

function refuser(message, journal = false) {
  throw new MigrationError(
    journal ? MIGRATION_ERROR_CODES.journalMalformed : MIGRATION_ERROR_CODES.conversionIncoherente,
    message,
  );
}

function decrire(source, cible, blocOctets) {
  if (!source || !cible || source.backend === cible.backend || source.nom === cible.nom) {
    refuser("La copie de migration exige deux volumes distincts ; la source reste intacte.");
  }
  for (const volume of [source, cible]) {
    if (
      typeof volume.nom !== "string" ||
      volume.nom.length === 0 ||
      volume.nom.length > 128 ||
      typeof volume.identifiantVolume !== "string" ||
      !IDENTIFIANT.test(volume.identifiantVolume)
    )
      refuser("Identité de migration invalide.");
  }
  if (source.identifiantVolume === cible.identifiantVolume) {
    refuser("La migration d'identité exige une identité d'arrivée distincte.");
  }
  if (typeof cible.backend?.relire !== "function") {
    refuser("La cible doit permettre une relecture authentifiée depuis le support, sans cache.");
  }
  const taille = source.backend.size();
  if (
    !Number.isSafeInteger(taille) ||
    taille <= 0 ||
    taille % SECTOR_SIZE !== 0 ||
    cible.backend.size() !== taille ||
    !Number.isSafeInteger(blocOctets) ||
    blocOctets < SECTOR_SIZE ||
    blocOctets > BLOC_DE_COPIE_MIGRATION ||
    blocOctets % SECTOR_SIZE !== 0
  )
    refuser("Géométrie de copie de migration invalide.");
  return {
    version: 1,
    source: source.nom,
    cible: cible.nom,
    identifiantSource: source.identifiantVolume,
    identifiantCible: cible.identifiantVolume,
    taille,
    blocOctets,
  };
}

function relireJournal(texte, attendu) {
  if (texte === null) return { position: 0, reprise: false };
  if (typeof texte !== "string" || texte.length > MAX_JOURNAL) {
    refuser("Journal de copie de migration illisible ; la source est conservée.", true);
  }
  let lu;
  try {
    lu = JSON.parse(texte);
  } catch {
    refuser("Journal de copie de migration tronqué ; la source est conservée.", true);
  }
  const champs = [...Object.keys(attendu), "position"].sort().join(",");
  if (
    lu === null ||
    typeof lu !== "object" ||
    Object.keys(lu).sort().join(",") !== champs ||
    Object.entries(attendu).some(([nom, valeur]) => lu[nom] !== valeur) ||
    !Number.isSafeInteger(lu.position) ||
    lu.position < 0 ||
    lu.position > attendu.taille ||
    (lu.position !== attendu.taille && lu.position % attendu.blocOctets !== 0)
  ) {
    refuser("Journal de copie incompatible avec les volumes présentés ; source conservée.", true);
  }
  return { position: lu.position, reprise: true };
}

async function lireBloc(backend, position, longueur, depuisSupport = false) {
  const octets = depuisSupport
    ? await backend.relire(position, longueur)
    : await backend.read(position, longueur);
  if (!(octets instanceof Uint8Array) || octets.byteLength !== longueur) {
    if (octets instanceof Uint8Array) octets.fill(0);
    refuser("Lecture incomplète pendant la copie de migration ; source conservée.");
  }
  return octets;
}

async function copierBloc(source, cible, position, longueur) {
  const clair = await lireBloc(source, position, longueur);
  try {
    await cible.write(position, clair);
    await cible.flush();
  } finally {
    clair.fill(0);
  }
}

async function verifierBloc(source, cible, position, longueur) {
  const original = await lireBloc(source, position, longueur);
  let copie;
  try {
    copie = await lireBloc(cible, position, longueur, true);
    if (!original.every((octet, rang) => octet === copie[rang])) {
      refuser("La copie relue diffère de la source ; aucune migration n'est publiée.");
    }
  } finally {
    original.fill(0);
    copie?.fill(0);
  }
}

/**
 * Copie le clair authentifié vers un volume sous une nouvelle identité, puis RELIT toute la copie.
 * `journal.lire()` rend null ou le texte sauvegardé ; `ecrire(texte)` ne rend qu'après persistance.
 * Un bloc n'est journalisé qu'après son flush. Une coupure rejoue le bloc depuis la source intacte.
 * Le journal est un indice de reprise, pas une preuve : même un avancement falsifié doit franchir
 * la comparaison complète finale. Le journal reste en place pour l'orchestrateur de publication.
 * Ce module garde au plus deux blocs de clair, en plus des caches propres aux backends.
 * Les backends doivent rendre des buffers indépendants.
 * La cible expose `relire(position, longueur)` : elle réauthentifie depuis le support, sans cache.
 * Cette préparation ne déverrouille pas, ne choisit pas les identités et ne bascule aucun coffre.
 */
export async function copierPourMigration({
  source,
  cible,
  journal,
  blocOctets = BLOC_DE_COPIE_MIGRATION,
}) {
  const description = decrire(source, cible, blocOctets);
  if (typeof journal?.lire !== "function" || typeof journal?.ecrire !== "function") {
    refuser("Un journal durable de reprise est obligatoire avant de copier.", true);
  }
  const { position, reprise } = relireJournal(await journal.lire(), description);
  const marquer = (rang) => journal.ecrire(JSON.stringify({ ...description, position: rang }));
  if (!reprise) await marquer(0);
  const ceder = creerCederLaMain();
  for (let rang = position; rang < description.taille; rang += blocOctets) {
    const longueur = Math.min(blocOctets, description.taille - rang);
    await copierBloc(source.backend, cible.backend, rang, longueur);
    await marquer(rang + longueur);
    await ceder();
  }
  // Ne jamais confondre le dernier rang du journal avec une preuve du contenu copié.
  for (let rang = 0; rang < description.taille; rang += blocOctets) {
    const longueur = Math.min(blocOctets, description.taille - rang);
    await verifierBloc(source.backend, cible.backend, rang, longueur);
    await ceder();
  }
  return Object.freeze({ copieVerifiee: true, reprise, octets: description.taille });
}
