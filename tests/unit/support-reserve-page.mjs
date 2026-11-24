// SUPPORT des épreuves de la PAGE de la réserve (#299, ADR 0048 §§ 7 et 8) : un `navigator.serviceWorker`
// factice, des Service Workers factices qui répondent par `MessageChannel` (le vrai mécanisme de la
// page), et une horloge de l'attente. Le code éprouvé est celui de `src/coquille/reserve-*.mjs`, tel quel.

export const SEQUENCE = 5;

/** Une cible d'événements minimale (`addEventListener`) avec déclenchement à la main. */
export class Cible {
  #ecouteurs = new Map();
  addEventListener(type, fn) {
    if (!this.#ecouteurs.has(type)) this.#ecouteurs.set(type, new Set());
    this.#ecouteurs.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.#ecouteurs.get(type)?.delete(fn);
  }
  ecouteurs(type) {
    return this.#ecouteurs.get(type)?.size ?? 0;
  }
  emettre(type, evenement = {}) {
    for (const fn of [...(this.#ecouteurs.get(type) ?? [])]) fn({ type, ...evenement });
  }
}

/**
 * Un Service Worker factice. `reponses` : type de question → fonction `(question) => réponse` ou `undefined`
 * (muet pour ce type). `etat` évolue (`installed`, `redundant`…) et émet `statechange`.
 */
export class FauxSW extends Cible {
  constructor({
    scriptURL = "https://coquille.test/sw-coquille.mjs",
    etat = "activated",
    reponses = {},
  } = {}) {
    super();
    this.scriptURL = scriptURL;
    this.state = etat;
    this.reponses = reponses;
    this.questions = [];
  }
  changerEtat(etat) {
    this.state = etat;
    this.emettre("statechange");
  }
  postMessage(question, transferts = []) {
    this.questions.push(question.type);
    const gestionnaire = this.reponses[question.type];
    if (gestionnaire === undefined) return;
    const resultat = gestionnaire(question);
    if (resultat === undefined) return;
    const port = transferts[0];
    // Une réponse peut être une promesse (pour SUSPENDRE une vérification) : le port répond à la résolution.
    Promise.resolve(resultat).then((valeur) => {
      if (valeur !== undefined) port.postMessage({ id: question.id ?? null, ...valeur });
    });
  }
}

export const identiteDe = (surcharges = {}) => ({
  version: "a".repeat(64),
  sequence: SEQUENCE,
  plancher: 0,
  retrait: false,
  entrees: 3,
  ...surcharges,
});

/** Les réponses d'un SW sain de séquence `sequence`. */
export function reponsesSaines({
  sequence = SEQUENCE,
  plancher = 0,
  retrait = false,
  version = "a".repeat(64),
} = {}) {
  return {
    version: () => identiteDe({ sequence, plancher, retrait, version }),
    verifier: () => ({
      ...identiteDe({ sequence, plancher, retrait, version }),
      ok: true,
      manquants: [],
      alteres: [],
    }),
    reparer: () => ({ ok: true, reparees: [], echecs: [] }),
  };
}

export class FausseInscription extends Cible {
  constructor({
    active = null,
    waiting = null,
    installing = null,
    scope = "https://coquille.test/",
    maj,
  } = {}) {
    super();
    this.active = active;
    this.waiting = waiting;
    this.installing = installing;
    this.scope = scope;
    this.misesAJour = 0;
    this.desinscrite = false;
    this.#maj = maj;
  }
  #maj;
  async update() {
    this.misesAJour += 1;
    if (this.#maj) return this.#maj(this);
    return undefined;
  }
  async unregister() {
    this.desinscrite = true;
    return true;
  }
}

/** `navigator.serviceWorker` factice. `inscription` null = aucune inscription pour la portée racine. */
export class FauxConteneur extends Cible {
  constructor({ controller = null, inscription = null, registrations } = {}) {
    super();
    this.controller = controller;
    this.inscription = inscription;
    this.registrations = registrations ?? (inscription ? [inscription] : []);
    this.enregistrements = [];
  }
  async getRegistration(portee) {
    return portee === "/" || portee === undefined ? (this.inscription ?? undefined) : undefined;
  }
  async getRegistrations() {
    return this.registrations;
  }
  async register(url, options) {
    this.enregistrements.push({ url, options });
    return this.inscription;
  }
  get ready() {
    return Promise.resolve(this.inscription);
  }
}

/** Un `navigator` factice : sans propriété `serviceWorker` quand `conteneur` est `undefined` (API absente). */
export function fauxNavigateur(conteneur) {
  return conteneur === undefined
    ? { userAgent: "test" }
    : { userAgent: "test", serviceWorker: conteneur };
}

/** Un Worker de confiance factice et ses compteurs : de quoi prouver « zéro Worker ». */
export function fabriqueDeTravailleurs({
  sequence = SEQUENCE,
  erreur = null,
  silence = false,
} = {}) {
  const fabrique = {
    crees: 0,
    termines: 0,
    creer() {
      fabrique.crees += 1;
      return { id: fabrique.crees };
    },
    annonce: async () => {
      if (silence) return { erreur: "delai" };
      return erreur ? { erreur } : { sequence };
    },
    terminer() {
      fabrique.termines += 1;
    },
  };
  return fabrique;
}

export const DELAIS = Object.freeze({
  delaiReponseMs: 40,
  delaiVerificationMs: 120,
  delaiAnnonceMs: 60,
  delaiDeGraceMs: 10,
  delaiInstallationInitialeMs: 200,
});

export const attendre = (ms) => new Promise((resoudre) => setTimeout(resoudre, ms));

/** Une promesse que l'épreuve règle à la main : de quoi SUSPENDRE une réponse du SW. */
export function suspendue() {
  let reprendre;
  const promesse = new Promise((resoudre) => {
    reprendre = resoudre;
  });
  return { promesse, reprendre };
}
