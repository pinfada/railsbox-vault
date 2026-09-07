// L'ORDRE des huit étapes du cycle de vie de référence, tenu par une garde (#163, ADR 0030).
//
// `docs/architecture.md` § « Cycle de vie de référence » énumère huit étapes depuis l'origine du
// dépôt. Jusqu'à #163 elles étaient une DESCRIPTION : deux d'entre elles vivaient dans le produit
// (#161), les autres dans des bancs, et rien ne rougissait si on les inversait. Ce module en fait
// une SUITE CONTRÔLÉE — l'ordre est vérifié, daté et publié, et une étape demandée avant celle dont
// elle dépend est refusée par `VAULT_COQUILLE_ETAPE_HORS_ORDRE`.
//
// ## Conclure n'est pas réussir
//
// Une étape se CONCLUT, avec une issue. C'est le point qui rend l'ordre tenable sans mentir :
// au démarrage ordinaire, le volume est verrouillé, donc il n'y a ni backend ni VM — l'étape 3 est
// alors conclue `differee`, et non sautée. Sauter une étape rendrait le journal muet exactement là
// où il devrait parler ; la conclure `differee` dit ce qui n'a pas eu lieu, et pourquoi le cadre
// applicatif peut néanmoins suivre.
//
// Les issues sont closes et finies : `franchie`, `differee`, `indisponible`, `banc`. La dernière
// existe parce que deux des huit étapes vivent encore hors du produit (export et migration), et
// que la table d'avancement de `docs/architecture.md` le dit ainsi plutôt que de l'omettre.
//
// ## Ce que ce module NE décide pas
//
// Ni le délai, ni le déclencheur, ni le sens de « verrouillé » : ils appartiennent à #25. L'étape
// `fermeture` est ici le RANG d'un geste, pas sa règle.

import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { ETATS_DU_VOLUME } from "./etat-de-la-coquille.mjs";

/**
 * Les huit étapes, dans l'ordre de `docs/architecture.md`. Les noms sont ceux du dossier, pas des
 * abréviations : `exclusiviteEtCanal` porte les deux gestes de l'étape 2 parce que l'architecture
 * les nomme ensemble — l'exclusivité et le canal privé sont acquis « avant qu'aucun document
 * applicatif n'existe », et les séparer laisserait croire qu'un ordre existe entre eux.
 */
export const ETAPES_DU_CYCLE = Object.freeze([
  /** 1. identités et compatibilité, vérifiées avant de demander une clé. */
  "identites",
  /** 2. exclusivité du volume et canal privé vers le Worker, avant tout document applicatif. */
  "exclusiviteEtCanal",
  /** 3. le Worker ouvre le backend, PUIS seulement la VM. */
  "backendPuisVm",
  /** 4. le document applicatif encadré sur l'origine distincte, port restreint transféré. */
  "cadreEtPort",
  /** 5. le guest lit et écrit ; un flush traverse toutes les couches avant son acquittement. */
  "ecritureEtBarriere",
  /** 6. export et migration créent une génération cohérente distincte. */
  "exportEtMigration",
  /** 7. verrouillage : arrêter les E/S, terminer proprement, fermer le handle, relâcher les clés. */
  "fermeture",
  /** 8. la reprise part d'un boot à froid, ou d'un instantané lié à une génération exacte. */
  "reprise",
]);

const RANGS = new Map(ETAPES_DU_CYCLE.map((etape, rang) => [etape, rang]));

/**
 * Les issues d'une étape. Closes et finies : une issue libre transformerait le journal en prose, et
 * une prose ne rougit pas.
 */
export const ISSUES_DETAPE = Object.freeze({
  /** L'étape a eu lieu. */
  franchie: "franchie",
  /** Elle n'a pas eu lieu, et ce n'est pas un échec : il lui manque un geste (déverrouillage). */
  differee: "differee",
  /** Ce moteur ne sait pas la faire : OPFS synchrone absent, capacité manquante. */
  indisponible: "indisponible",
  /** Elle vit hors du produit, dans un banc de `public/vm/`. La table d'avancement le dit ainsi. */
  banc: "banc",
});

const ISSUES_CONNUES = new Set(Object.values(ISSUES_DETAPE));

/** @param {string} code @param {string} message */
function refus(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * EXIGE qu'une étape soit conclable : connue, non déjà conclue, et précédée de toutes celles dont
 * elle dépend. Elle vit hors du journal parce qu'elle ne LIT qu'un état et n'en écrit aucun — c'est
 * la garde, et une garde se relit d'un bloc.
 *
 * @param {Map<string, object>} parEtape ce qui est déjà conclu
 * @param {string} etape
 * @param {string} issue
 */
function exigerLOrdre(parEtape, etape, issue) {
  const rang = RANGS.get(etape);
  if (rang === undefined) {
    throw refus(
      CODES_REFUS_COQUILLE.etapeHorsOrdre,
      `Étape inconnue du cycle de vie : ${String(etape)}.`,
    );
  }
  if (!ISSUES_CONNUES.has(issue)) {
    throw refus(
      CODES_REFUS_COQUILLE.etapeHorsOrdre,
      `Issue inconnue pour l'étape « ${etape} » : ${String(issue)}.`,
    );
  }
  if (parEtape.has(etape)) {
    throw refus(
      CODES_REFUS_COQUILLE.etapeHorsOrdre,
      `L'étape « ${etape} » est déjà conclue : le journal est une suite, pas un état.`,
    );
  }
  // La garde porte sur TOUTES les étapes précédentes et non sur la seule qui précède
  // immédiatement : une étape sautée puis une autre franchie ferait deux fautes dont une seule
  // serait vue.
  for (let anterieur = 0; anterieur < rang; anterieur += 1) {
    const attendue = ETAPES_DU_CYCLE[anterieur];
    if (parEtape.has(attendue)) continue;
    throw refus(
      CODES_REFUS_COQUILLE.etapeHorsOrdre,
      `L'étape « ${etape} » a été demandée avant « ${attendue} », dont elle dépend.`,
    );
  }
}

/**
 * EXIGE un backend ouvert avant de démarrer la VM. C'est la preuve par l'échec de l'inverse : un
 * boot demandé sur un volume verrouillé — ou sur un moteur qui n'en atteint aucun — est refusé, et
 * le refus porte le code de l'ORDRE plutôt qu'un code de support : ce n'est pas le stockage qui a
 * échoué, c'est l'étape 3 qui a été demandée à l'envers.
 *
 * @param {{ etatDuVolume: string }} observation
 */
export function exigerLeBackend({ etatDuVolume }) {
  if (etatDuVolume === ETATS_DU_VOLUME.ouvert) return;
  throw refus(
    CODES_REFUS_COQUILLE.etapeHorsOrdre,
    "La machine virtuelle démarre APRÈS le backend : aucun volume n'est ouvert pour l'instant.",
  );
}

/**
 * Ouvre un JOURNAL de cycle de vie.
 *
 * `maintenant` est injecté plutôt que lu de `performance.now()` : le journal date ses étapes, et
 * une épreuve qui dépendrait d'une horloge réelle mesurerait la machine plutôt que l'ordre.
 *
 * @param {{ maintenant?: () => number }} [options]
 */
export function journalDuCycle({ maintenant = () => 0 } = {}) {
  /** @type {{ etape: string, issue: string, instantMs: number, motif: string | null }[]} */
  const inscrites = [];
  const parEtape = new Map();
  return {
    /**
     * CONCLUT une étape, avec son issue et — quand elle en a un — le fait observé qui l'explique.
     * `motif` ne porte jamais une donnée du volume : c'est un nom, pas un contenu.
     *
     * @param {string} etape @param {string} issue @param {string | null} [motif]
     */
    conclure(etape, issue, motif = null) {
      exigerLOrdre(parEtape, etape, issue);
      const inscrite = { etape, issue, instantMs: maintenant(), motif };
      inscrites.push(inscrite);
      parEtape.set(etape, inscrite);
    },
    /**
     * Le cadre applicatif peut-il être créé ? Seulement une fois l'étape du backend et de la VM
     * CONCLUE — quelle que soit son issue.
     *
     * L'issue est indifférente, et il faut dire pourquoi : un cadre qui n'attendrait qu'une VM
     * DÉMARRÉE n'apparaîtrait jamais sur un moteur sans OPFS synchrone, ni sur un coffre verrouillé.
     * Ce que l'ordre exige n'est pas que la VM tourne, c'est que la coquille ait DIT où elle en est
     * avant d'ouvrir une frontière.
     */
    peutEncadrer: () => parEtape.has("backendPuisVm"),
    exigerLeBackend,
    /** L'issue d'une étape, ou `null` si elle n'est pas conclue. */
    issueDe: (etape) => parEtape.get(etape)?.issue ?? null,
    /** Le relevé, dans l'ordre où les étapes ont été conclues. Aucune donnée du volume n'y entre. */
    releve: () => inscrites.map((inscrite) => ({ ...inscrite })),
  };
}
