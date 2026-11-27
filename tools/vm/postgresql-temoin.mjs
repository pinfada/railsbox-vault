// Ce que les épreuves VM de PostgreSQL (#343) partagent : l'application TÉMOIN, la lecture des
// lignes que le guest dit sur la série, et les gestes HTTP d'une écriture acquittée.
//
// L'application témoin est `apps/rails-new-postgresql` : générée par `rails _8.1.4.1_ new -d
// postgresql` puis `bin/rails generate scaffold Note libelle:string`, SANS aucune modification pour
// le coffre (ADR 0056). Les épreuves ne connaissent d'elle que ce que le générateur a produit : la
// ressource `notes` et son formulaire. Elles ne dépendent d'aucune route ajoutée.
//
// La sonde de démarrage de la coquille (`/vault/health`) appartient à l'application de RÉFÉRENCE ;
// une application extérieure n'en a pas (#351). Sous Node, le harnais sonde donc ce que l'application
// témoin sait rendre — `/notes` —, ce qui n'engage que l'épreuve.

/** L'identité sous laquelle le témoin est fabriqué : `npm run app:paquet -- --source … --id …`. */
export const ID_DU_TEMOIN = "rails-new-postgresql";
export const VERSION_DU_TEMOIN = "1.0.0";

/** Ce que l'épreuve dit de faire quand le paquet servi n'est pas le témoin. */
export const GESTE_DU_TEMOIN =
  "npm run app:paquet -- --source apps/rails-new-postgresql " +
  `--id ${ID_DU_TEMOIN} --version ${VERSION_DU_TEMOIN} puis « npm run image:manifest »`;

/** Les réglages que la décision du mainteneur exige, tels que `SHOW` les rend (ADR 0056). */
export const REGLAGES_ATTENDUS = Object.freeze({
  fsync: "on",
  synchronous_commit: "on",
  full_page_writes: "on",
  data_checksums: "on",
});

/** Les méthodes de synchronisation du WAL qui vont jusqu'au disque sous Linux. */
export const METHODES_DURABLES = Object.freeze([
  "fdatasync",
  "fsync",
  "open_datasync",
  "open_sync",
]);

/**
 * Lit la ligne `[postgresql] reglages clé=valeur …` que le guest dit APRÈS l'avoir relue par
 * `SHOW` sur la connexion de l'application. Rend `null` si la ligne n'est pas encore venue.
 *
 * @param {readonly string[]} journal
 * @returns {Record<string, string> | null}
 */
export function reglagesLus(journal) {
  const ligne = journal.find((texte) => /^\[postgresql\] reglages \S+=/.test(texte));
  if (ligne === undefined) return null;
  return Object.fromEntries(
    ligne
      .replace(/^\[postgresql\] reglages /, "")
      .trim()
      .split(/\s+/)
      .map((paire) => paire.split("=")),
  );
}

/** Une pause bornée. */
export function pause(millisecondes) {
  return new Promise((resoudre) => setTimeout(resoudre, millisecondes));
}

/**
 * Attend qu'une ligne du journal du guest satisfasse `motif`, borné.
 *
 * @param {readonly string[]} journal
 * @param {RegExp} motif
 * @param {number} delaiMs
 */
export async function attendreLigne(journal, motif, delaiMs) {
  const debut = Date.now();
  for (;;) {
    const trouvee = journal.find((ligne) => motif.test(ligne));
    if (trouvee !== undefined) return trouvee;
    if (Date.now() - debut > delaiMs) {
      throw new Error(
        `aucune ligne ${motif} en ${Math.round(delaiMs / 1000)} s ; dernières lignes :\n` +
          journal.slice(-25).join("\n"),
      );
    }
    await pause(500);
  }
}

const texte = (reponse) => new TextDecoder().decode(reponse.corps);

/**
 * Attend que l'application réponde 200 sur `/notes`. Rend la durée d'attente.
 *
 * @param {{ requete: Function }} vm
 * @param {{ delaiMs: number, journal: readonly string[] }} reglages
 */
export async function attendreLesNotes(vm, { delaiMs, journal }) {
  const debut = Date.now();
  let derniere = "aucune";
  while (Date.now() - debut < delaiMs) {
    const refus = journal.find((ligne) => /application NON lancee|REFUS/.test(ligne));
    if (refus !== undefined) throw new Error(`le guest refuse : ${refus}`);
    try {
      const reponse = await vm.requete("GET", "/notes", {
        delaiMs: 10_000,
        entetes: [["Accept", "text/html"]],
      });
      if (reponse.statut === 200) return Date.now() - debut;
      derniere = `statut ${reponse.statut}`;
    } catch (erreur) {
      derniere = erreur instanceof Error ? erreur.message : String(erreur);
    }
    await pause(5_000);
  }
  throw new Error(`/notes n'a pas répondu 200 en ${Math.round(delaiMs / 1000)} s ; ${derniere}`);
}

/**
 * PRÉPARE la soumission d'une note : lit le formulaire, son jeton CSRF et le cookie de session.
 * Rend le corps et les en-têtes du POST ; c'est à l'appelant de l'envoyer, pour qu'il puisse
 * armer une coupure sur sa réponse.
 *
 * @param {{ requete: Function }} vm
 * @param {string} libelle
 */
export async function preparerUneNote(vm, libelle) {
  const formulaire = await vm.requete("GET", "/notes/new", {
    entetes: [["Accept", "text/html"]],
  });
  if (formulaire.statut !== 200) {
    throw new Error(`/notes/new a répondu ${formulaire.statut}`);
  }
  const page = texte(formulaire);
  const jeton = page.match(/name="authenticity_token" value="([^"]+)"/)?.[1];
  if (jeton === undefined) throw new Error("jeton CSRF introuvable dans /notes/new");
  const cookies = formulaire.entetesRepetees
    .filter(([nom]) => nom === "set-cookie")
    .map(([, valeur]) => valeur.split(";")[0]);
  const corps = new URLSearchParams({ authenticity_token: jeton, "note[libelle]": libelle });
  return {
    corps: new TextEncoder().encode(corps.toString()),
    entetes: [
      ["Accept", "text/html"],
      ["Content-Type", "application/x-www-form-urlencoded"],
      ...(cookies.length > 0 ? [["Cookie", cookies.join("; ")]] : []),
    ],
  };
}

/**
 * Relit la liste des notes et dit si `libelle` y figure.
 *
 * @param {{ requete: Function }} vm
 * @param {string} libelle
 */
export async function noteListee(vm, libelle) {
  const reponse = await vm.requete("GET", "/notes", { entetes: [["Accept", "text/html"]] });
  if (reponse.statut !== 200) throw new Error(`/notes a répondu ${reponse.statut}`);
  return texte(reponse).includes(libelle);
}
