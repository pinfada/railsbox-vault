// QUAND la page lance le téléchargement anticipé du premier démarrage (#348), et ce qu'elle en publie.
//
// Pur, comme le reste du répertoire : ni DOM, ni stockage, ni horloge. La page
// (`public/coquille/telechargement-anticipe-de-la-page.mjs`) l'applique ; le Worker
// (`public/coquille/prechargement-worker.mjs`) fait le travail (`src/vm/prechargement-des-artefacts.mjs`).

/** Le type du seul message que le Worker du téléchargement anticipé poste. */
export const TYPE_DU_BILAN = "vault.coquille.telechargement-anticipe";

/** L'étape où l'application démarre pour la première fois : « Travailler dans l'application ». */
export const ETAPE_DU_PREMIER_DEMARRAGE = 4;

const ecarte = (motif) => Object.freeze({ voulu: false, motif });

/**
 * Le téléchargement anticipé est-il voulu pour cette page ?
 *
 * Seulement pendant la VISITE, avant l'étape 4 : c'est là qu'un premier démarrage attend la personne.
 * Après, l'application a déjà été installée et le magasin la garde ; une mise à jour proposée ne se
 * télécharge pas sans le geste. Jamais sous Firefox, où l'application ne démarre pas dans cette
 * version (`LIMITE_DE_FIREFOX`) : 200 Mio y seraient téléchargés pour rien. Jamais en vue complète,
 * le harnais des épreuves de frontière, qui joue les gestes dans des ordres que le parcours n'offre pas.
 *
 * @param {{ etapeAtteinte: number, moteur: string, vueComplete: boolean }} contexte
 * @returns {{ voulu: true } | { voulu: false, motif: string }}
 */
export function telechargementAnticipeVoulu({ etapeAtteinte, moteur, vueComplete }) {
  if (vueComplete) return ecarte("vue-complete");
  if (moteur === "firefox") return ecarte("firefox");
  if (!(etapeAtteinte < ETAPE_DU_PREMIER_DEMARRAGE)) return ecarte("visite-avancee");
  return Object.freeze({ voulu: true });
}

/** Un mot du bilan : une issue (`deja-present`) ou un statut du magasin (`admis`, `MAGASIN_LENT`…). */
const MOT = /^[A-Za-z][A-Za-z_-]{0,63}$/;
const NOMS = new Set(["wasm", "bios", "vgaBios", "kernel", "initrd", "rootfs", "paquet"]);

/**
 * Ce que la page PUBLIE d'un bilan reçu : des mots connus, recopiés un par un, et rien d'autre. Un
 * message d'une autre forme ne publie que « illisible ».
 *
 * @param {unknown} donnee
 * @returns {{ issue: string, artefacts?: Record<string, string> }}
 */
export function bilanPublie(donnee) {
  const bilan = donnee?.type === TYPE_DU_BILAN ? donnee.bilan : null;
  if (typeof bilan?.issue !== "string" || !MOT.test(bilan.issue)) return { issue: "illisible" };
  const publie = { issue: bilan.issue };
  if (bilan.artefacts !== null && typeof bilan.artefacts === "object") {
    publie.artefacts = Object.fromEntries(
      Object.entries(bilan.artefacts).filter(
        ([nom, statut]) => NOMS.has(nom) && typeof statut === "string" && MOT.test(statut),
      ),
    );
  }
  return publie;
}
