// Les deux GESTES de l'utilisateur qui font avancer le cycle assemblé (#163, ADR 0030 ; #169,
// ADR 0031).
//
// Démarrer l'application (étape 3) et VERROUILLER le coffre (étape 7). Ce sont des BOUTONS, comme
// les quatre de #162, et c'est une décision : ce que la coquille fait du volume appartient à qui
// l'ouvre. Un démarrage automatique déciderait à sa place de payer deux minutes de boot.
//
// ## « Verrouiller », et un seul mot pour une seule chose (#169, ADR 0031, décision 1)
//
// Le second geste s'appelait « fermer le coffre » tant que le délai et le déclencheur appartenaient
// à #25. Ils lui appartiennent désormais, et le geste porte leur nom : **un coffre fermé et un
// coffre verrouillé sont la même chose**, et deux mots pour une chose sont un mensonge en attente.
// Ce que le geste FAIT n'a pas changé d'un appel — c'est le chemin de #163, arrêt de la VM,
// capture, `close()`, puis `terminate()` par la page ; ce qui a changé est qu'il est désormais
// NOMMÉ, et qu'un second déclencheur — le délai d'inactivité de `verrouillage.mjs` — emprunte
// exactement le même.
//
// Le TYPE de message ne bouge pas, lui : le canal privilégié porte toujours
// `vault.coquille.fermer-le-coffre`. Renommer un type ajoute et retire une entrée d'une liste tenue
// par un cliquet (ADR 0028, contrat strict) pour un nom qu'aucun utilisateur ne lit ; ce qui doit
// être unique est le mot que la coquille MONTRE, et il l'est.
//
// Ce module ne contient AUCUNE garde d'ordre. Le refus d'un boot demandé avant l'ouverture du
// backend vient du Worker de confiance (`VAULT_COQUILLE_ETAPE_HORS_ORDRE`) : la garde vit du côté
// qui tient le volume, et non du côté qui grise un bouton. Un bouton grisé n'apprend rien à qui
// l'atteint autrement, et l'épreuve n'a rien à mesurer — c'est déjà l'argument de l'ADR 0028 sur
// `VAULT_COQUILLE_VOLUME_VERROUILLE`.
//
// ## Ce que chaque geste INSCRIT au journal, et pourquoi il ne peut pas mentir
//
// La revue de sécurité de la PR #171 a relevé deux affirmations fausses, et elles se corrigent ici :
//
//  - l'étape 3 restait `differee` APRÈS un boot réussi, et l'étape 8 n'était conclue nulle part,
//    pendant que `docs/architecture.md` les classait PRODUIT. Le geste de démarrage RÉVISE donc
//    l'étape 3 et conclut l'étape 8 selon ce que ce boot a réellement fait ;
//  - l'étape 5 — « le guest lit et écrit, un flush traverse toutes les couches » — était conclue
//    `franchie` à TOUTE fermeture, même sans le moindre démarrage. Elle ne l'est désormais que si
//    une application a démarré ET qu'au moins une barrière du guest a été acquittée.

import { ISSUES_DETAPE } from "./cycle-de-vie.mjs";
import { DECLENCHEURS, exigerUnDeclencheur } from "./verrouillage.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";

/**
 * Branche les deux gestes et rend de quoi les déclencher sans passer par le document — ce dont une
 * épreuve a besoin, et ce qu'aucun chemin de produit n'emploie.
 *
 * @param {{ racine: Document, demander: (type: string, corps?: object) => Promise<any>,
 *           cycle: { issueDe: (etape: string) => string | null, releve: () => object[],
 *                    conclure: (etape: string, issue: string, motif?: string | null) => void },
 *           rapport: Record<string, unknown>, publier: () => void,
 *           avantVerrouillage?: (declencheur: string) => void,
 *           apresRefusDOrdre?: (code: string) => void,
 *           apresRefusDeVerrouillage?: (code: string | null, declencheur: string) => void,
 *           apresVerrouillage: (declencheur: string) => void }} liaison
 */
export function brancherLesGestesDuCycle(liaison) {
  // Un DÉMARRAGE EN VOL est retenu ici, et nulle part ailleurs : c'est ce module qui sait qu'un
  // geste est parti et que sa réponse n'est pas revenue. Il sert à une seule chose — refuser un
  // verrouillage demandé PENDANT un boot, sous le code de l'ORDRE (voir `verrouiller`).
  const enVol = { demarrage: false };
  const contexte = { ...liaison, enVol, dire: ecrivainDEtat(liaison.racine) };
  const demarrerLApplication = () => demarrer(contexte);
  const verrouillerLeCoffre = (declencheur = DECLENCHEURS.geste) =>
    verrouiller(contexte, exigerUnDeclencheur(declencheur));
  liaison.racine.querySelector("#demarrer-application")?.addEventListener("click", () => {
    void demarrerLApplication();
  });
  liaison.racine.querySelector("#verrouiller-le-coffre")?.addEventListener("click", () => {
    // Le déclencheur est un ARGUMENT, posé par celui qui déclenche. Le bouton dit « geste » ; la
    // surveillance d'inactivité dira « inactivite ». Aucune variable ne garde la réponse entre deux
    // gestes, et aucun relevé ne peut donc décrire le mauvais.
    void verrouillerLeCoffre(DECLENCHEURS.geste);
  });
  return Object.freeze({ demarrerLApplication, verrouillerLeCoffre });
}

/** Écrit la ligne d'état du cycle. La seule façon dont ces deux gestes touchent le document. */
function ecrivainDEtat(racine) {
  return (texte) => {
    const noeud = racine.querySelector("#cycle-etat");
    if (noeud !== null) noeud.textContent = texte;
  };
}

/** Inscrit une conclusion et publie le relevé. */
function inscrire({ cycle, rapport }, etape, issue, motif = null) {
  cycle.conclure(etape, issue, motif);
  rapport.cycle = cycle.releve();
}

/**
 * Conclut une étape, et ne fait rien si elle l'est déjà. Un second geste de fermeture ne doit pas
 * faire échouer une fermeture qui, elle, s'est bien passée : le journal refuse une étape conclue
 * deux fois autrement que par une révision, et c'est ici la bonne réponse à ce refus.
 */
function conclureSiPossible(contexte, etape, issue, motif = null) {
  if (contexte.cycle.issueDe(etape) !== null) return;
  inscrire(contexte, etape, issue, motif);
}

/**
 * RÉVISE une étape conclue `differee`, ou la conclut si elle ne l'est pas encore. Une étape déjà
 * franchie reste franchie : l'issue est finale, et le journal la défend.
 */
function reviserOuConclure(contexte, etape, issue, motif = null) {
  if (contexte.cycle.issueDe(etape) === ISSUES_DETAPE.differee) {
    inscrire(contexte, etape, issue, motif);
    return;
  }
  conclureSiPossible(contexte, etape, issue, motif);
}

/**
 * INSCRIT au journal ce qu'un démarrage a réellement fait.
 *
 * L'ordre des conclusions est celui des rangs, et il est tenu par le journal lui-même : l'étape 8 ne
 * peut être conclue qu'une fois les étapes 5, 6 et 7 conclues, fût-ce `differee` ou `banc`.
 *
 * @param {object} contexte @param {object} rendu la réponse du Worker de confiance
 */
function inscrireLeDemarrage(contexte, rendu) {
  if (!rendu.demarree) {
    // Aucune application n'est servie par cette origine : ce n'est pas un échec du geste, c'est
    // l'absence de son objet. L'étape 3 devient `indisponible`, et le journal le dit.
    reviserOuConclure(contexte, "backendPuisVm", ISSUES_DETAPE.indisponible, rendu.motif ?? null);
    return;
  }
  reviserOuConclure(contexte, "backendPuisVm", ISSUES_DETAPE.franchie, rendu.volume ?? null);
  // ÉTAPE 5 — « un flush traverse toutes les couches avant son acquittement ». Elle n'est franchie
  // que si le GUEST a réellement acquitté une barrière. La conclure sur la seule existence du geste
  // ferait affirmer au journal ce qu'il n'a pas observé.
  const acquittees = rendu.counts?.["flush-ack"] ?? 0;
  conclureSiPossible(
    contexte,
    "ecritureEtBarriere",
    acquittees > 0 ? ISSUES_DETAPE.franchie : ISSUES_DETAPE.differee,
    `barrieres-acquittees:${acquittees}`,
  );
  conclureSiPossible(contexte, "exportEtMigration", ISSUES_DETAPE.banc, "public/vm/ — export");
  conclureSiPossible(contexte, "fermeture", ISSUES_DETAPE.differee, "coffre encore ouvert");
  // ÉTAPE 8 — la REPRISE. Elle n'a lieu que si l'application était DÉJÀ installée : un démarrage qui
  // vient d'installer le disque ne reprend rien, il commence. Le motif dit par quel chemin.
  const reprise = rendu.installation?.installee === false;
  conclureSiPossible(
    contexte,
    "reprise",
    reprise ? ISSUES_DETAPE.franchie : ISSUES_DETAPE.differee,
    reprise ? (rendu.instantaneUtilise ? "instantane" : "boot-froid") : "installation-initiale",
  );
}

/** ÉTAPE 3 — le geste qui démarre l'application : installation si besoin, backend, puis VM. */
async function demarrer(contexte) {
  const { demander, rapport, publier, dire, enVol } = contexte;
  dire("cycle:demarrage-en-cours");
  enVol.demarrage = true;
  try {
    const rendu = await demander("application", {});
    rapport.application = rendu;
    if (rendu.barrieres !== undefined) rapport.barrieres = rendu.barrieres;
    if (rendu.etat !== undefined) rapport.etat = rendu.etat;
    inscrireLeDemarrage(contexte, rendu);
    publier();
    dire(rendu.demarree ? "cycle:application-demarree" : `cycle:sans-application:${rendu.motif}`);
    return rendu;
  } catch (erreur) {
    // Un refus est PUBLIÉ, jamais avalé : c'est par lui que l'épreuve de l'ordre lit « boot demandé
    // avant l'ouverture du backend », et par lui que l'utilisateur apprend pourquoi. Le journal, lui,
    // n'inscrit RIEN : un geste refusé n'a rien fait avancer.
    rapport.application = { demarree: false, code: erreur?.code ?? null };
    publier();
    dire(`cycle:demarrage-refuse:${erreur?.code ?? "inconnu"}`);
    return rapport.application;
  } finally {
    // Le drapeau retombe QUOI QU'IL ARRIVE. Levé pour toujours par un boot qui échoue, il refuserait
    // tout verrouillage jusqu'au rechargement — un coffre qu'on ne peut plus fermer.
    enVol.demarrage = false;
    contexte.apresDemarrage?.();
  }
}

/**
 * ÉTAPE 7 — le VERROUILLAGE, c'est-à-dire la fermeture propre nommée par ce qu'elle obtient.
 *
 * Le Worker arrête la VM, capture l'instantané dans l'ordre des six gestes de l'ADR 0024 décision 6,
 * ferme les volumes ; PUIS la page termine le Worker et recharge la coquille (`apresVerrouillage`).
 *
 * **L'ordre est le contrat, et l'`await` est ce qui le tient.** `close()` attend les E/S déjà
 * ACCEPTÉES (#132) et laisse le volume dans l'état que la capture vient de décrire. Terminer avant
 * lui perd deux choses, et ce sont elles le motif :
 *
 *  - **les écritures EN VOL**, que le guest croit acquittées et qui ne sont pas encore sur le
 *    support. C'est `SEC-DURABLE-001` qui l'interdit, et rien d'autre ;
 *  - **la cohérence de l'INSTANTANÉ avec le volume.** La capture a lieu dans `relacherTout`, AVANT
 *    le `close()` : un instantané scellé sur un volume dont les dernières écritures manquent décrit
 *    un état qui n'existe pas, et l'ouverture suivante l'écarte (ADR 0024, décision 4) — donc un
 *    boot à FROID, c'est-à-dire la décision 3 de l'ADR 0031 défaite.
 *
 * **Ce que ce motif n'est PLUS**, et il faut le dire : de #163 à la première rédaction de #169, ce
 * commentaire affirmait que terminer avant `close()` laisserait le handle exclusif tenu et ferait
 * rendre `VAULT_STORAGE_BUSY` à l'ouverture suivante. C'est FAUX, mesuré sur Chromium et sur
 * Firefox par `tests/browser/opfs-block-backend.spec.mjs` › « le moteur rend l'exclusivité du handle
 * à la MORT du Worker qui le tenait » : le moteur relâche l'exclusivité avec le contexte du Worker.
 * L'ordre reste, son motif est meilleur (constat 2 de la revue de sécurité de la PR #174).
 *
 * Un verrouillage REFUSÉ ne termine rien : le Worker vit encore, il tient encore ses handles, et le
 * tuer là laisserait exactement l'état que l'ordre existe pour éviter. Mais il ne se tait pas non
 * plus : il RAPPELLE l'appelant (`apresRefusDeVerrouillage`), qui doit ré-armer ce qu'il avait
 * désarmé et réconcilier l'état qu'il publie avec celui du Worker. Un geste qui échoue en silence
 * sur ce chemin-là laisse un coffre ouvert que plus rien ne referme.
 */
/**
 * LA GARDE D'ORDRE du verrouillage, et elle vient AVANT tout le reste.
 *
 * Un verrouillage demandé pendant qu'un démarrage est en vol arriverait au Worker DERRIÈRE un boot
 * de deux minutes : la coquille attendrait sans rien dire, puis capturerait l'instantané d'une
 * machine qui vient de démarrer. Le refus porte le code de l'ORDRE —
 * `VAULT_COQUILLE_ETAPE_HORS_ORDRE`, existant depuis #163 — et non un code de support : ce n'est pas
 * le stockage qui a échoué, c'est l'étape 3 qui n'a pas conclu.
 *
 * Ce refus-ci ne TUE RIEN : le geste n'a jamais atteint le Worker, le coffre est légitimement
 * ouvert, et ce qu'il faut est RÉARMER le délai que la surveillance venait de désarmer. C'est toute
 * la différence avec un refus du Worker, et les deux ne se confondent pas.
 *
 * @returns {{ verrouille: false, code: string, horsOrdre: true } | null} le refus, ou `null` si
 *   l'ordre laisse passer.
 */
function refusDOrdre({ enVol, dire, apresRefusDOrdre }, declencheur) {
  if (enVol?.demarrage !== true) return null;
  const code = CODES_REFUS_COQUILLE.etapeHorsOrdre;
  dire(`cycle:verrouillage-refuse:${code}`);
  // Le DÉCLENCHEUR voyage avec le refus, et il décide de ce qui suit : un geste refusé se reclique,
  // un délai refusé reste DÛ (ADR 0032, décision 5 ; constat 3 de la revue de la PR #177).
  apresRefusDOrdre?.(code, declencheur);
  return { verrouille: false, code, horsOrdre: true };
}

async function verrouiller(contexte, declencheur) {
  const { demander, rapport, publier, dire } = contexte;
  const { avantVerrouillage, apresRefusDeVerrouillage, apresVerrouillage } = contexte;
  const horsOrdre = refusDOrdre(contexte, declencheur);
  if (horsOrdre !== null) return horsOrdre;
  // Le CHRONOMÈTRE part ici, et pas au clic : les DEUX déclencheurs — le bouton et le délai
  // d'inactivité — passent par cette porte, et une mesure prise sur le seul clic ne dirait rien du
  // second. C'est aussi la raison pour laquelle ce module ne connaît pas les déclencheurs : il en
  // sert un de plus sans changer d'une ligne.
  avantVerrouillage?.(declencheur);
  dire("cycle:verrouillage-en-cours");
  try {
    const rendu = await demander("fermeture", {});
    rapport.etat = rendu.etat;
    rapport.barrieres = rendu.barrieres;
    rapport.fermeture = { capture: rendu.capture ?? null };
    // Les étapes 5, 6 et 8 sont conclues ICI quand aucun démarrage ne les a conclues : sans
    // application, le guest n'a rien écrit — `differee`, et non `franchie`. L'étape 6 reste un BANC,
    // et le journal le dit plutôt que de la passer sous silence.
    conclureSiPossible(contexte, "ecritureEtBarriere", ISSUES_DETAPE.differee, "aucun démarrage");
    conclureSiPossible(contexte, "exportEtMigration", ISSUES_DETAPE.banc, "public/vm/ — export");
    reviserOuConclure(contexte, "fermeture", ISSUES_DETAPE.franchie);
    conclureSiPossible(contexte, "reprise", ISSUES_DETAPE.differee, "à la prochaine ouverture");
    publier();
  } catch (erreur) {
    const code = erreur?.code ?? null;
    dire(`cycle:verrouillage-refuse:${code ?? "inconnu"}`);
    // Un refus du WORKER ne rend pas la main en silence, et c'est la correction du constat 3 de la
    // revue de sécurité de la PR #174. Sans ce rappel, un verrouillage refusé laissait exactement
    // l'état que le verrouillage existe pour quitter : le coffre OUVERT, le cadre applicatif en
    // place — et AUCUN délai, la surveillance s'étant désarmée avant d'appeler ce geste sans que
    // rien ne la ré-arme. Le coffre restait ouvert pour toujours sans que personne l'ait décidé.
    //
    // Ce que l'appelant en fait est écrit dans `conduiteApresUnRefusDeVerrouillage` : le Worker est
    // terminé, le cadre retiré, le refus publié avant tout, et la coquille NE recharge pas.
    apresRefusDeVerrouillage?.(code, declencheur);
    return { verrouille: false, code };
  }
  apresVerrouillage(declencheur);
  dire("cycle:coffre-verrouille");
  return { verrouille: true };
}

/** Les codes que ce module cite dans ses lignes d'état. Exporté pour que les épreuves les nomment. */
export const CODES_DU_CYCLE = Object.freeze({
  horsOrdre: CODES_REFUS_COQUILLE.etapeHorsOrdre,
  applicationAbsente: CODES_REFUS_COQUILLE.applicationAbsente,
});
