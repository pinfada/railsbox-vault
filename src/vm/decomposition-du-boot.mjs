// DÉCOMPOSITION du temps de reprise (#60) : où passent les secondes d'un boot.
//
// Extraite de `boot-de-reference.mjs` par #163, pour la raison qui a déjà scindé trois fichiers du
// dépôt (#93) : ce module-ci n'INSTRUMENTE rien du boot — il pose des jalons `performance.now()` et
// repère quelques lignes dans le flux série BRUT du guest — et le boot, lui, ouvre un volume et fait
// démarrer un émulateur. Deux natures, deux fichiers, et celui du boot repasse sous le seuil
// d'alerte de `tests/unit/taille-des-fichiers.test.mjs`.
//
// Chaque jalon horodate un événement RÉELLEMENT observé ; un jalon jamais vu reste `null` et n'est
// pas inventé.

/**
 * Repères de la décomposition #60 dans le flux série BRUT du guest : exactement les lignes que
 * `guest-init.sh` imprime sur la console avant que le pont `@VLT1` ne démarre. Déclarés hors de la
 * fabrique parce qu'ils ne dépendent d'aucun boot : ce sont les repères du guest de référence, les
 * mêmes d'une exécution à l'autre.
 */
const REPERES_SERIE = Object.freeze([
  ["montageDisqueApp", "[init] montage du disque applicatif"],
  ["lancementApp", "[init] lancement de l'application"],
  ["pontSerieActif", "[init] pont serie actif"],
]);

/**
 * Décomposition finale des jalons. Les durées sont en millisecondes, arrondies, relatives au jalon
 * indiqué. `healthMs` reste la mesure publiée (fenêtre de `awaitHealth`) ; les autres l'éclairent.
 *
 * Séparée de l'enregistrement des jalons : poser un jalon et calculer un écart sont deux gestes,
 * le premier au fil du boot, le second une fois pour toutes à la fin.
 *
 * @param {Map<string, number>} jalons horodatages posés, un jamais vu restant absent
 * @param {{ premierOctet: number | null, dmesgDernierSec: number | null, healthMs: number }} vus
 */
function decomposerJalons(jalons, { premierOctet, dmesgDernierSec, healthMs, empreintesV86Ms }) {
  const t = (cle) => jalons.get(cle) ?? null;
  const delta = (a, b) => (a === null || b === null ? null : Number((b - a).toFixed(0)));
  return {
    acquisitionRuntimeMs: delta(t("debut"), t("runtimePret")),
    // Part de l'acquisition passée à CONFRONTER les octets reçus aux 256 bits du manifeste (#123).
    // Elle est publiée à part parce qu'elle est le prix d'une garantie, et qu'un prix qu'on ne
    // relève pas ne se discute pas : la revue de sécurité l'a exigée sur le chemin de boot réel,
    // et non en contexte de page comme la première estimation de la PR.
    empreintesV86Ms: empreintesV86Ms ?? null,
    initEmulateurMs: delta(t("runtimePret"), t("bootRendu")),
    premierOctetSerieMs: delta(t("bootRendu"), premierOctet),
    noyauVersMontageMs: delta(premierOctet, t("montageDisqueApp")),
    montageVersLancementMs: delta(t("montageDisqueApp"), t("lancementApp")),
    lancementVersPontMs: delta(t("lancementApp"), t("pontSerieActif")),
    pontVersSanteMs: delta(t("pontSerieActif"), t("santePrete")),
    healthMs,
    invariantMs: delta(t("santePrete"), t("invariantRendu")),
    noyauDmesgDernierSec: dmesgDernierSec,
  };
}

/**
 * Enregistreur de décomposition du temps de reprise (#60). Il n'INSTRUMENTE rien du boot : il pose
 * des jalons `performance.now()` que le banc lit déjà, plus quelques jalons repérés dans le flux
 * série BRUT du guest (`onSerial`). Chaque jalon horodate un événement RÉELLEMENT observé ; un jalon
 * jamais vu reste `null` et n'est pas inventé.
 */
export function createBootTimeline() {
  const jalons = new Map();
  let tampon = "";
  let premierOctet = null;
  let dmesgDernierSec = null;

  const noter = (cle) => {
    if (!jalons.has(cle)) jalons.set(cle, performance.now());
  };

  return {
    /** Jalon posé côté hôte (entrée du boot, runtime prêt, boot rendu, santé, invariant). */
    marquer: noter,
    /** Fragment de série brut : repère les lignes d'init et le dernier horodatage dmesg du noyau. */
    ingererSerie(fragment) {
      if (fragment.length === 0) return;
      if (premierOctet === null) premierOctet = performance.now();
      // On garde une fenêtre glissante bornée : un repère tient sur une seule ligne.
      tampon = (tampon + fragment).slice(-4096);
      for (const [cle, aiguille] of REPERES_SERIE) {
        if (!jalons.has(cle) && tampon.includes(aiguille)) noter(cle);
      }
      const horodatages = tampon.match(/\[\s*(\d+\.\d+)\]/g);
      if (horodatages) {
        const dernier = Number.parseFloat(
          horodatages[horodatages.length - 1].replace(/[[\]]/g, ""),
        );
        if (Number.isFinite(dernier)) dmesgDernierSec = dernier;
      }
    },
    /** Décomposition finale, déléguée à `decomposerJalons`. */
    decomposer({ healthMs, empreintesV86Ms = null }) {
      return decomposerJalons(jalons, {
        premierOctet,
        dmesgDernierSec,
        healthMs,
        empreintesV86Ms,
      });
    },
  };
}
