// ENREGISTREUR DE CHRONOLOGIE des scénarios de bout en bout (#165).
//
// Il existe parce que l'instruction de deux intermittents — #165 et #152 — a buté sur la même
// absence : **le scénario qui échoue est précisément celui qui ne laisse aucun relevé.** Chaque
// scénario écrit son `reports/e2e/<nom>.json` par un `writeFileSync` placé à sa DERNIÈRE ligne ;
// une assertion rouge saute cette ligne, et l'artefact du run rouge contient les relevés des huit
// scénarios verts — pas celui du neuvième. Mesuré sur les artefacts conservés :
//
//   - run 34054146291 tentative 1 (migration rouge) : `migration-volume-versionne.json` ABSENT ;
//   - run 34283481251 tentative 1 (instantané rouge) : `instantane-reprise.json` ABSENT ;
//   - run 34395610743 tentative 1 (instantané rouge) : `instantane-reprise.json` ABSENT.
//
// Dater l'échec a donc demandé de dézipper la trace Playwright et de la lire à la main. Ce module
// rend ce travail inutile pour l'occurrence suivante : il écrit un relevé **à chaque étape**, si
// bien qu'un scénario interrompu en laisse un qui s'arrête là où il s'est arrêté. C'est la seule
// propriété qui compte, et elle impose le reste : aucune mise en tampon, aucune écriture différée,
// un fichier réécrit ENTIER à chaque étape plutôt qu'ajouté en fin — un JSON tronqué par une
// coupure ne se relit pas.
//
// Ce que le relevé porte, et rien de plus : le nom du scénario, l'instant de chaque étape en temps
// absolu ET en millisecondes depuis le début, ce que l'étape dit d'elle-même (un compte, une
// empreinte, un motif), puis l'issue. Aucun octet du volume, aucune clé : ces fichiers montent dans
// l'artefact public d'un run.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Marqueur que `public/vm/reference-banc.mjs` pose devant la série série du guest quand un boot
 * expire. Il est répété ici plutôt qu'importé : la coquille du banc est un module de navigateur, et
 * l'épreuve qui lit son message tourne sous Node. Le couple est tenu par
 * `tests/unit/e2e-chronologie.test.mjs`, qui relit la chaîne DANS le fichier de la coquille.
 */
export const MARQUEUR_SERIE_DU_GUEST = "--- série du guest";

/** Ce qu'un nom de scénario a le droit de contenir une fois devenu nom de fichier. */
const CARACTERES_INTERDITS = /[^a-z0-9-]+/g;

/**
 * Nom de fichier DÉRIVÉ du nom du scénario : `migration-volume-versionne.spec.mjs` devient
 * `migration-volume-versionne`. Sans dérivation, un nom de scénario porteur d'un séparateur de
 * chemin écrirait hors du dossier des relevés.
 *
 * @param {string} scenario
 */
export function nomDeFichierDuScenario(scenario) {
  const sansExtension = String(scenario).replace(/\.spec\.mjs$/, "");
  const assaini = sansExtension
    .toLowerCase()
    .replace(CARACTERES_INTERDITS, "-")
    .replace(/^-+|-+$/g, "");
  return assaini === "" ? "scenario-sans-nom" : assaini;
}

/**
 * EXTRAIT la série du guest d'un message d'erreur, ou rend `null` s'il n'en porte pas.
 *
 * La série ne voyage que par le MESSAGE : une erreur qui traverse `page.evaluate` perd tout le
 * reste (`public/vm/reference-banc.mjs` le dit et c'est pour cela qu'il l'y met). Ce qui précède le
 * marqueur est l'erreur elle-même ; ce qui suit la ligne du marqueur est la série.
 *
 * @param {string | null | undefined} message
 * @returns {string | null}
 */
export function extraireLaSerieDuGuest(message) {
  if (typeof message !== "string") return null;
  const debut = message.indexOf(MARQUEUR_SERIE_DU_GUEST);
  if (debut === -1) return null;
  const finDeLaLigneDuMarqueur = message.indexOf("\n", debut);
  if (finDeLaLigneDuMarqueur === -1) return null;
  return message.slice(finDeLaLigneDuMarqueur + 1);
}

/**
 * Ouvre une chronologie pour UN scénario. Chaque étape est écrite sur le support avant que l'appel
 * ne rende la main.
 *
 * @param {{
 *   scenario: string,
 *   dossier: string,
 *   maintenant?: () => Date,
 *   ecrireFichier?: (chemin: string, contenu: string) => void,
 *   creerDossier?: (chemin: string) => void,
 * }} reglages
 */
export function creerChronologie({
  scenario,
  dossier,
  maintenant = () => new Date(),
  ecrireFichier = (chemin, contenu) => writeFileSync(chemin, contenu, "utf8"),
  creerDossier = (chemin) => mkdirSync(chemin, { recursive: true }),
}) {
  const base = nomDeFichierDuScenario(scenario);
  const cheminDuReleve = join(dossier, `chronologie-${base}.json`);
  const cheminDeLaSerie = join(dossier, `serie-guest-${base}.txt`);
  const debut = maintenant();
  /** @type {Array<Record<string, unknown>>} */
  const etapes = [];
  /** @type {{ message: string, serieDuGuest: string | null } | null} */
  let echec = null;
  let statut = "en-cours";

  function deposer() {
    creerDossier(dossier);
    const releve = {
      scenario,
      debutLe: debut.toISOString(),
      derniereEcritureLe: maintenant().toISOString(),
      statut,
      etapes,
      echec,
    };
    ecrireFichier(cheminDuReleve, `${JSON.stringify(releve, null, 2)}\n`);
  }

  return {
    /** Chemins des deux fichiers, pour qu'une épreuve puisse les joindre au rapport Playwright. */
    chemins: { releve: cheminDuReleve, serie: cheminDeLaSerie },

    /**
     * Date UNE étape et dépose le relevé. `details` est recopié tel quel : c'est le scénario qui
     * sait ce que son étape a mesuré.
     *
     * @param {string} nom
     * @param {Record<string, unknown>} [details]
     */
    etape(nom, details = {}) {
      const a = maintenant();
      etapes.push({
        nom,
        a: a.toISOString(),
        depuisLeDebutMs: a.getTime() - debut.getTime(),
        ...details,
      });
      deposer();
      return a;
    },

    /**
     * CLÔT la chronologie sur une issue. Un échec porte son message ; si ce message contient une
     * série du guest, elle est écrite dans SON fichier — entière, hors du JSON, parce qu'une série
     * de vingt kilo-octets rend un relevé illisible et qu'elle se lit avec un pager, pas avec `jq`.
     *
     * Rend la série extraite, ou `null` : l'appelant la joint au rapport Playwright.
     *
     * @param {{ statut: string, message?: string | null }} issue
     * @returns {string | null}
     */
    clore({ statut: issue, message = null }) {
      statut = issue;
      const serieDuGuest = extraireLaSerieDuGuest(message);
      if (message !== null) {
        echec = {
          message:
            serieDuGuest === null
              ? message
              : message.slice(0, message.indexOf(MARQUEUR_SERIE_DU_GUEST)),
          // Le NOM, pas le chemin : le relevé monte dans un artefact où la série est son voisin,
          // et un chemin absolu d'exécutant n'y désigne rien.
          serieDuGuest: serieDuGuest === null ? null : basename(cheminDeLaSerie),
          serieDuGuestCaracteres: serieDuGuest === null ? 0 : serieDuGuest.length,
        };
      }
      deposer();
      if (serieDuGuest !== null) {
        creerDossier(dossier);
        ecrireFichier(cheminDeLaSerie, serieDuGuest);
      }
      return serieDuGuest;
    },
  };
}
