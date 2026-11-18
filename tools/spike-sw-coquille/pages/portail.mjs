// PORTAIL et ÉTATS DE FRAÎCHEUR du spike D1h (DoR révisée, §§ 2 et 6). Prototype : le produit le
// recopiera dans `public/coquille/` ; ici il est servi par la réserve du SW comme le reste.
//
// Rien ici ne lit une clé, un volume ou un secret : le portail ne voit que des versions et des empreintes.

export const CODES = Object.freeze({
  ABSENTE: "VAULT_COQUILLE_RESERVE_ABSENTE",
  INCOMPLETE: "VAULT_COQUILLE_RESERVE_INCOMPLETE",
  ALTEREE: "VAULT_COQUILLE_RESERVE_ALTEREE",
  DIVERGENTE: "VAULT_COQUILLE_RESERVE_DIVERGENTE",
  PERIMEE: "VAULT_COQUILLE_RESERVE_PERIMEE",
});

/** Les six états de fraîcheur (les cinq du défi + l'état nominal). `texte` = ce que la personne lit. */
export const ETATS = Object.freeze({
  EN_COURS: {
    id: "verification-en-cours",
    texte: "Vérification de la version en cours…",
    portail: "attend, au plus DELAI_VERIFICATION_MS, puis bascule en « non vérifiable »",
  },
  ECHOUEE: {
    id: "verification-echouee",
    texte: "La vérification a échoué : l'éditeur a publié une version que cette copie n'a pas pu installer. Cette version n'est peut-être plus la bonne.",
    portail: "autorise, avertissement permanent affiché",
  },
  NON_VERIFIABLE: {
    id: "version-courante-non-verifiable",
    texte: "Impossible de savoir si cette version a été retirée (hors connexion, ou éditeur injoignable).",
    portail: "autorise (le hors connexion est la fonction), avertissement permanent, jamais « à jour »",
  },
  PRETE: {
    id: "mise-a-jour-prete",
    texte: "Une version plus récente est prête. Fermez TOUTES les fenêtres du coffre, puis rouvrez-le.",
    portail: "autorise, bandeau permanent ; la mise à jour ne s'applique qu'après la fermeture de tous les clients",
  },
  REVOQUEE: {
    id: "revocation-connue",
    texte: "Cette version a été retirée par son éditeur. Fermez TOUTES les fenêtres du coffre, puis rouvrez-le.",
    portail: "REFUSE (VAULT_COQUILLE_RESERVE_PERIMEE) avant tout Worker et toute clé",
  },
  VERIFIEE: {
    id: "version-verifiee",
    texte: "Version vérifiée auprès de l'éditeur à l'instant (preuve non signée).",
    portail: "autorise",
  },
});

/**
 * ÉTAT DE FRAÎCHEUR — fonction pure. Priorité : le fait CONNU (attente installée) passe avant
 * l'incertitude, et l'incertitude avant l'état nominal.
 * @param {{ maj: "en-cours"|"ok"|"rejetee"|"echec"|"delai"|"non-tentee", attente: null|{ sequence: number, plancher: number, retrait: boolean }, sequenceCourante: number }} o
 */
export function etatDeFraicheur({ maj, attente, sequenceCourante }) {
  if (attente && (attente.retrait || attente.plancher > sequenceCourante)) return ETATS.REVOQUEE;
  if (attente) return ETATS.PRETE;
  // « echec » = `update()` rejetée : réseau coupé OU réponse HTTP d'erreur, que le navigateur ne
  // distingue pas (S8). On n'a RIEN appris de l'origine : non vérifiable, pas « échouée ».
  // « rejetee » = une version différente est apparue ET son installation a été refusée : preuve que
  // l'origine a publié autre chose, que cette copie n'a pas su installer.
  if (maj === "rejetee") return ETATS.ECHOUEE;
  if (maj === "echec" || maj === "delai" || maj === "non-tentee") return ETATS.NON_VERIFIABLE;
  if (maj === "en-cours") return ETATS.EN_COURS;
  return ETATS.VERIFIEE;
}

/**
 * DÉCISION DU PORTAIL — fonction pure. Un refus porte un code typé ET une cause (diagnostic).
 * Aucun Worker n'est créé tant que `autorise` n'est pas vrai.
 */
export function decider({ controleur, sequencePage, identite, verification, fraicheur, controleurChange }) {
  if (!controleur) return { autorise: false, code: CODES.ABSENTE, cause: "aucun-controleur" };
  if (identite === null || identite === undefined) return { autorise: false, code: CODES.ABSENTE, cause: "silence-du-sw" };
  if (identite.retrait) return { autorise: false, code: CODES.PERIMEE, cause: "retrait" };
  if (controleurChange) return { autorise: false, code: CODES.DIVERGENTE, cause: "controleur-change" };
  if (identite.sequence !== sequencePage) return { autorise: false, code: CODES.DIVERGENTE, cause: "sequence" };
  if (verification === null || verification === undefined) return { autorise: false, code: CODES.ABSENTE, cause: "silence-du-sw" };
  if (verification.manquants?.length > 0) return { autorise: false, code: CODES.INCOMPLETE, cause: "entrees-manquantes", detail: verification.manquants };
  if (verification.alteres?.length > 0) return { autorise: false, code: CODES.ALTEREE, cause: "entrees-alterees", detail: verification.alteres };
  if (fraicheur === ETATS.REVOQUEE) return { autorise: false, code: CODES.PERIMEE, cause: "plancher" };
  return { autorise: true, code: null, cause: null };
}

/** Pose une question au SW par un MessageChannel ; `null` si rien n'arrive avant le délai. */
export function interroger(cible, type, delaiMs, extra = {}) {
  return new Promise((resoudre) => {
    const canal = new MessageChannel();
    const minuterie = setTimeout(() => resoudre(null), delaiMs);
    canal.port1.onmessage = (evenement) => {
      clearTimeout(minuterie);
      resoudre(evenement.data);
    };
    try {
      cible.postMessage({ type, ...extra }, [canal.port2]);
    } catch {
      clearTimeout(minuterie);
      resoudre(null);
    }
  });
}

/**
 * Lance `registration.update()` et OBSERVE son résultat réel : `update()` résolue ne veut pas dire
 * « à jour » (installation rejetée, S7) et ne dit rien d'une installation encore en cours.
 * Rend `{ maj, attente, chronologie }` ; ne jette jamais.
 */
export async function observerLaFraicheur(registration, { delaiMs, delaiReponseMs = 3000 }) {
  const chronologie = [];
  const t0 = performance.now();
  const noter = (e) => chronologie.push([Math.round(performance.now() - t0), e]);
  let installationRejetee = false;
  let trouve = false;
  const suivre = (ver) => {
    ver.addEventListener("statechange", () => {
      noter(`installing:${ver.state}`);
      if (ver.state === "redundant") installationRejetee = true;
    });
  };
  registration.addEventListener("updatefound", () => {
    trouve = true;
    noter("updatefound");
    if (registration.installing) suivre(registration.installing);
  });
  noter("update()");
  const miseAJour = registration.update().then(
    () => {
      noter("update()-resolue");
      return "ok";
    },
    (erreur) => {
      noter("update()-rejetee:" + erreur?.name);
      return "echec";
    },
  );
  const echeance = new Promise((r) => setTimeout(() => r("delai"), delaiMs));
  let maj = await Promise.race([miseAJour, echeance]);
  // `update()` résolue n'est PAS la fin de l'installation : on attend qu'elle se règle (borné).
  if (maj === "ok" && registration.installing) {
    const fin = new Promise((r) => {
      const ver = registration.installing;
      const verifier = () => {
        if (ver.state === "installed" || ver.state === "redundant" || ver.state === "activated") r("regle");
      };
      ver.addEventListener("statechange", verifier);
      verifier();
    });
    const issue = await Promise.race([fin, new Promise((r) => setTimeout(() => r("delai"), Math.max(0, delaiMs - (performance.now() - t0))))]);
    if (issue === "delai") maj = "delai";
  }
  if (maj === "ok" && (installationRejetee || (trouve && !registration.waiting && !registration.installing))) maj = "rejetee";
  let attente = null;
  if (registration.waiting) {
    const reponse = await interroger(registration.waiting, "version", delaiReponseMs);
    attente = reponse ? { sequence: reponse.sequence, plancher: reponse.plancher, retrait: reponse.retrait } : { sequence: -1, plancher: 0, retrait: false, muet: true };
  }
  noter("etat:" + maj + (attente ? " attente=" + JSON.stringify(attente) : ""));
  return { maj, attente, chronologie, enRetard: maj === "delai" ? miseAJour : null };
}

/**
 * LE PORTAIL. `creerLeTravailleur` est l'effet à protéger (dans le produit : `creerCanalDeConfiance`).
 * Rend `{ autorise, code, cause, fraicheur, travailleur }`. Aucun secret ne circule ici.
 * `crochets.avantCreation` / `crochets.apresVerification` laissent l'épreuve interposer une faute.
 */
export async function ouvrirLePortail({ sequencePage, delaiVerificationMs = 5000, delaiReponseMs = 3000, creerLeTravailleur, crochets = {} }) {
  const conteneur = navigator.serviceWorker;
  const controleur = conteneur.controller;
  let controleurChange = false;
  const surChangement = () => {
    controleurChange = true;
  };
  conteneur.addEventListener("controllerchange", surChangement);
  try {
    if (!controleur) return { ...decider({ controleur: null }), fraicheur: ETATS.NON_VERIFIABLE };
    const registration = await conteneur.getRegistration("/");
    const [identite, verification, observation] = await Promise.all([
      interroger(controleur, "version", delaiReponseMs),
      interroger(controleur, "verifier", delaiReponseMs),
      registration
        ? observerLaFraicheur(registration, { delaiMs: delaiVerificationMs, delaiReponseMs })
        : Promise.resolve({ maj: "non-tentee", attente: null }),
    ]);
    const fraicheur = etatDeFraicheur({ maj: observation.maj, attente: observation.attente, sequenceCourante: identite?.sequence ?? sequencePage });
    await crochets.apresVerification?.();
    const decision = decider({ controleur: true, sequencePage, identite, verification, fraicheur, controleurChange });
    if (!decision.autorise) return { ...decision, fraicheur, observation };
    await crochets.avantCreation?.();
    // Le contrôleur a-t-il changé entre la vérification et la création ? (identité d'objet + événement)
    if (conteneur.controller !== controleur || controleurChange) {
      return { autorise: false, code: CODES.DIVERGENTE, cause: "controleur-change", fraicheur, observation };
    }
    const travailleur = creerLeTravailleur();
    // POIGNÉE DE MAIN : rien ne passe au Worker avant qu'il ait dit QUELLE version il exécute.
    const accueil = await new Promise((resoudre) => {
      const minuterie = setTimeout(() => resoudre({ erreur: "delai" }), delaiReponseMs + 4000);
      travailleur.addEventListener("message", (e) => {
        clearTimeout(minuterie);
        resoudre(e.data);
      });
      travailleur.addEventListener("error", () => {
        clearTimeout(minuterie);
        resoudre({ erreur: "chargement" });
      });
      travailleur.postMessage({ type: "bonjour" });
    });
    if (accueil.erreur) {
      travailleur.terminate();
      // Un Worker qui ne se charge pas ne dit pas pourquoi (`error` générique) : le code typé vient
      // d'une NOUVELLE vérification de la réserve, jamais de l'événement.
      const apres = await interroger(conteneur.controller ?? controleur, "verifier", delaiReponseMs);
      if (apres === null) return { autorise: false, code: CODES.ABSENTE, cause: "silence-du-sw", fraicheur };
      if (apres.alteres?.length) return { autorise: false, code: CODES.ALTEREE, cause: "entree-alteree-apres-le-portail", detail: apres.alteres, fraicheur };
      if (apres.manquants?.length) return { autorise: false, code: CODES.INCOMPLETE, cause: "entree-absente-apres-le-portail", detail: apres.manquants, fraicheur };
      return { autorise: false, code: CODES.ABSENTE, cause: "worker-" + accueil.erreur, fraicheur };
    }
    if (accueil.sequence !== sequencePage || conteneur.controller !== controleur || controleurChange) {
      travailleur.terminate();
      return { autorise: false, code: CODES.DIVERGENTE, cause: accueil.sequence !== sequencePage ? "worker-d-une-autre-version" : "controleur-change-apres-creation", fraicheur, accueil };
    }
    return { autorise: true, code: null, cause: null, fraicheur, travailleur, accueil, observation };
  } finally {
    conteneur.removeEventListener("controllerchange", surChangement);
  }
}
