// CÉDER LA MAIN au fil qui exécute une boucle longue (#192, correction I1 de la revue de la PR #203).
//
// ## Ce que la mesure a établi
//
// Le Worker de confiance était déclaré MORT PAR SILENCE pendant le premier démarrage de
// l'application. La cause n'était ni le relais ni le fil de la page : c'est l'INSTALLATION du disque
// applicatif. Le scellement initial du volume neuf (`scellerTout`, 512 Mio) puis le versement du
// disque (`verserFluxDansVolume`) enchaînent des `await` qui se règlent en MICROTÂCHES — l'écriture
// OPFS synchrone, un chiffrement déjà résolu, un flux déjà en mémoire —, si bien que la boucle
// d'événements du Worker ne reprend jamais la main. Le battement du canal privilégié est une
// MINUTERIE de ce même fil : elle ne tire pas, et la page constate trente secondes de silence.
//
// Relevé dans Chrome le 12 septembre 2026, jalons posés par le Worker lui-même : 32,2 s sans une
// seule tâche entre la fin du scellement de session et le premier battement, coquille de cadre
// NEUTRALISÉE (aucune requête relayée) ; 22,6 s avec elle ; 84 s onglet caché. Le seuil est 30 s.
//
// ## Ce que ce module fait, et ce qu'il ne fait pas
//
// Il rend une promesse qui se règle par une TÂCHE (`setTimeout`), et non par une microtâche, quand
// la tranche courante a duré plus de `TRANCHE_MS`. Entre deux tranches, la boucle d'événements sert
// ce qui attend : le battement, les messages du canal de relais. Il ne change AUCUN octet écrit, ni
// leur ordre, ni le format du volume : il change l'instant où la boucle rend la main, et rien d'autre.
//
// Une tranche de cinquante millisecondes coûte une tâche vide vingt fois par seconde : quelques
// dixièmes de pour cent d'un versement de soixante secondes.

/** Durée d'une tranche de travail ininterrompu, en millisecondes. */
export const TRANCHE_MS = 50;

/**
 * Fabrique un « céder la main » pour UNE boucle.
 *
 * Une fabrique plutôt qu'un état de module : deux boucles qui tournent ensemble ne se partagent pas
 * une horloge, et une épreuve peut injecter la sienne.
 *
 * @param {{ maintenant?: () => number, planifier?: (geste: () => void) => void, trancheMs?: number }} [options]
 * @returns {() => Promise<boolean>} rend `true` quand la main a été cédée
 */
export function creerCederLaMain({
  maintenant = () => performance.now(),
  planifier = (geste) => setTimeout(geste, 0),
  trancheMs = TRANCHE_MS,
} = {}) {
  let debutDeTranche = maintenant();
  return async function cederLaMain() {
    if (maintenant() - debutDeTranche < trancheMs) return false;
    await new Promise((regler) => planifier(regler));
    debutDeTranche = maintenant();
    return true;
  };
}

/**
 * PARCOURT `[0, taille)` par blocs de `pas` octets en cédant la main entre deux tranches. La
 * relecture synchrone d'un fichier de 512 Mio — son empreinte — coûte cinq secondes sans elle.
 *
 * @param {number} taille
 * @param {number} pas
 * @param {(offset: number, longueur: number) => void} geste
 */
export async function parcourirEnCedantLaMain(taille, pas, geste) {
  const cederLaMain = creerCederLaMain();
  for (let offset = 0; offset < taille; offset += pas) {
    geste(offset, Math.min(pas, taille - offset));
    await cederLaMain();
  }
}
