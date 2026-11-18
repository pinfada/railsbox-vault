// Un magasin de la révocation AUTOUR d'exécuteurs espions (#310, ADR 0049) : chaque appel est noté
// avec la phase que l'état avait AU MOMENT de l'appel (c'est ce qui prouve l'ordre, I2 et I23″), et
// chaque promesse (envoi, lectures, noter) est tenue par l'épreuve.

import { TYPES_PRIVILEGIES } from "../../src/coquille/contrat-de-messages.mjs";
import { creerLaRevocation } from "../../src/coquille/magasin-de-la-revocation.mjs";
import { lirePublic } from "../../src/coquille/vue-de-la-revocation.mjs";
import { reponseDInventaire } from "./support-revocation.mjs";

export function differe() {
  let resoudre;
  let rejeter;
  const promesse = new Promise((a, b) => {
    resoudre = a;
    rejeter = b;
  });
  return { promesse, resoudre, rejeter };
}

/** Laisse les promesses se régler (microtâches, puis une tâche). */
export async function tourner() {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
}

export const SUCCES = Object.freeze({
  type: TYPES_PRIVILEGIES.revoquerEnUrgenceReponse,
  versionEnveloppe: 4,
  restants: { phrase: 1 },
  retires: { recuperation: 1 },
  nombreRetires: 1,
  nombreRestants: 1,
  copieDeSauvegardeRetiree: false,
  etat: "ouvert",
  barrieres: 3,
});

/**
 * @param {{ indice?: boolean, masquer?: Function, publier?: Function, consigner?: Function,
 *           oublier?: Function, terminer?: Function, revenir?: Function, noter?: Function,
 *           vueARendre?: Function, envoyer?: Function, relire?: Function }} surcharges
 */
export function fabriquer(surcharges = {}) {
  const appels = [];
  const lectures = new Map();
  const envois = [];
  const notes = [];
  const consignes = [];
  let magasin = null;
  const phase = () => magasin.etat().phase;
  const executeurs = {
    envoyer: () => {
      appels.push(["envoyer", phase()]);
      if (surcharges.envoyer) return surcharges.envoyer();
      const d = differe();
      envois.push(d);
      return d.promesse;
    },
    relire: (lecture) => {
      appels.push(["relire", lecture, phase()]);
      if (surcharges.relire) return surcharges.relire(lecture);
      const d = differe();
      lectures.set(lecture, d);
      return d.promesse;
    },
    publier: (lecture, donnees) => {
      appels.push(["publier", lecture, phase(), lirePublic(magasin.etat()) === donnees.public]);
      return surcharges.publier?.(lecture, donnees);
    },
    noter: () => {
      appels.push(["noter", phase()]);
      if (surcharges.noter) return surcharges.noter();
      const d = differe();
      notes.push(d);
      return d.promesse;
    },
    oublier: () => {
      appels.push(["oublier", phase()]);
      return surcharges.oublier?.();
    },
    terminer: () => {
      appels.push(["terminer", phase()]);
      return surcharges.terminer?.();
    },
    revenir: () => {
      appels.push(["revenir", phase()]);
      return surcharges.revenir?.();
    },
    masquer: () => {
      appels.push(["masquer", phase()]);
      return surcharges.masquer ? surcharges.masquer() : true;
    },
    consigner: (diagnostic) => {
      appels.push(["consigner", phase()]);
      consignes.push(diagnostic);
      return surcharges.consigner?.(diagnostic);
    },
    vueARendre: () => {
      appels.push(["vue-a-rendre", phase()]);
      return surcharges.vueARendre?.();
    },
  };
  magasin = creerLaRevocation({ executeurs, indice: surcharges.indice ?? false });
  const noms = (nom) => appels.filter(([n]) => n === nom);
  return { magasin, appels, lectures, envois, notes, consignes, noms, executeurs };
}

/** Résout la lecture `n` avec une réponse d'inventaire conforme. */
export async function lire(f, n, options) {
  f.lectures.get(n).resoudre(reponseDInventaire(options));
  await tourner();
}

/** Amène le magasin dans la phase demandée, PAR SON API PUBLIQUE. */
export async function amener(f, phase) {
  const { magasin } = f;
  if (phase === "F0") return;
  magasin.demarrer();
  if (phase === "FL") return;
  if (phase === "FE") {
    f.lectures.get(1).rejeter(new Error("lecture"));
    await tourner();
    return;
  }
  await lire(f, 1);
  if (phase === "FC") return;
  magasin.appliquer({ type: "coffre-ouvert", moyen: "phrase" });
  if (phase === "SL") return;
  await lire(f, magasin.etat().lecture ?? 2);
  if (phase === "P") return;
  magasin.appliquer({ type: "demander-la-revocation" });
  if (phase === "C") return;
  magasin.appliquer({ type: "oui" });
  if (phase === "V") return;
  f.envois[0].resoudre({ ...SUCCES });
  await tourner();
  if (phase === "RL") return;
  await lire(f, magasin.etat().lecture);
  if (phase === "K") return;
  throw new Error(`phase non gérée par amener : ${phase}`);
}
