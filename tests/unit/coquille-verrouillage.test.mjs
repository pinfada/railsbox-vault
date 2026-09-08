/**
 * VERROUILLER : l'état, la règle et le déclencheur d'inactivité (#169, tranche 1 de #25, ADR 0031).
 *
 * Trois familles de gardes, toutes PURES ou à dépendances INJECTÉES, et c'est la condition pour
 * qu'une campagne de mutation puisse les atteindre — le motif est celui de
 * `tools/muter-gardes-coquille.mjs` : « une garde écrite dans `public/main.mjs` ne serait éprouvable
 * que par un navigateur, donc jamais par un enfant borné ».
 *
 *  - la CONDUITE après un verrouillage : l'état atteint, le rechargement, ce qui n'est pas gardé, et
 *    l'instantané qui SURVIT (révision de l'ADR 0024 décision 8) ;
 *  - le DÉLAI d'inactivité : sa valeur par défaut, ses bornes tenues par le code, et le refus de
 *    tout ce qui sort de ces bornes ;
 *  - la SURVEILLANCE : ce qui remet le délai à zéro, ce qui ne le remet PAS, et le fait qu'elle ne
 *    s'arme que sur un coffre `ouvert`.
 *
 * Ce que ce fichier ne mesure pas : ce que le NAVIGATEUR fait de ces décisions — qu'un `pointerdown`
 * soit livré, qu'un onglet caché ralentisse une minuterie, qu'un `location.reload()` rejoue le
 * cycle. C'est `tests/browser/coquille-cycle-de-vie.spec.mjs`, sur les trois moteurs, et
 * `tests/e2e/reprise-coquille-boot-froid.spec.mjs` en intégration continue.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DELAI_INACTIVITE_MAXIMUM_MS,
  DELAI_INACTIVITE_MINIMUM_MS,
  DELAI_INACTIVITE_MS,
  EVENEMENTS_DACTIVITE,
  SIGNAUX_DACTIVITE,
  SIGNAUX_SANS_EFFET,
  conduiteApresLeVerrouillage,
  delaiDInactivite,
  estUnSignalDActivite,
  surveillanceDInactivite,
} from "../../src/coquille/verrouillage.mjs";
import { CAUSES_DE_MORT } from "../../src/coquille/mort-du-worker.mjs";
import { brancherLesGestesDuCycle } from "../../src/coquille/gestes-du-cycle.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";

/** Capture l'exception d'un geste, ou échoue. `assert.throws` ne rend rien à l'appelant. */
function refusDe(geste) {
  try {
    geste();
  } catch (erreur) {
    return erreur;
  }
  throw new assert.AssertionError({ message: "Le geste n'a rien refusé." });
}

/**
 * Une HORLOGE et un ORDONNANCEUR feints, pilotés à la milliseconde par l'épreuve.
 *
 * Le délai par défaut est de dix minutes : une suite qui l'attendrait vraiment ne serait pas une
 * suite. Ce que l'épreuve pilote est le TEMPS, pas la vitesse de la machine qui la joue — et c'est
 * la raison pour laquelle la surveillance reçoit son horloge au lieu de lire la sienne.
 */
function tempsFeint() {
  let instant = 0;
  let suivant = 1;
  const minuteries = new Map();
  return {
    maintenant: () => instant,
    planifier: (geste, delai) => {
      const identifiant = suivant;
      suivant += 1;
      minuteries.set(identifiant, { geste, echeance: instant + delai });
      return identifiant;
    },
    annuler: (identifiant) => minuteries.delete(identifiant),
    /** Avance l'horloge et déclenche toutes les minuteries échues, dans l'ordre de leur échéance. */
    avancerDe(millisecondes) {
      const cible = instant + millisecondes;
      for (;;) {
        const echues = [...minuteries.entries()]
          .filter(([, minuterie]) => minuterie.echeance <= cible)
          .sort((gauche, droite) => gauche[1].echeance - droite[1].echeance);
        if (echues.length === 0) break;
        const [identifiant, minuterie] = echues[0];
        minuteries.delete(identifiant);
        instant = minuterie.echeance;
        minuterie.geste();
      }
      instant = cible;
    },
    /** Combien de minuteries sont armées. Une surveillance désarmée n'en laisse aucune. */
    get armees() {
      return minuteries.size;
    },
  };
}

/** Une surveillance sous horloge feinte, et le journal de ce qu'elle a verrouillé. */
function surveillanceFeinte(options = {}) {
  const temps = tempsFeint();
  const verrouillages = [];
  const surveillance = surveillanceDInactivite({
    maintenant: temps.maintenant,
    planifier: temps.planifier,
    annuler: temps.annuler,
    verrouiller: () => verrouillages.push(temps.maintenant()),
    ...options,
  });
  return { temps, surveillance, verrouillages };
}

// --- La CONDUITE après un verrouillage ------------------------------------------------------------

test("verrouiller atteint l'état que la mort du Worker atteint par accident", () => {
  const conduite = conduiteApresLeVerrouillage({ etatConnu: ETATS_DU_VOLUME.ouvert });
  assert.equal(conduite.etat, ETATS_DU_VOLUME.verrouille);
  // La cause est la TROISIÈME de la table de l'ADR 0030 : la coquille se donne la mort à elle-même.
  // Un seul état, deux chemins — et le second est celui-ci.
  assert.equal(conduite.cause, CAUSES_DE_MORT.terminaison);
  assert.equal(conduite.code, CODES_REFUS_COQUILLE.workerMort);
});

test("verrouiller n'invente pas un verrou sur un moteur qui n'a jamais rien pu ouvrir", () => {
  const conduite = conduiteApresLeVerrouillage({ etatConnu: ETATS_DU_VOLUME.indisponible });
  assert.equal(conduite.etat, ETATS_DU_VOLUME.indisponible);
});

test("rien n'est gardé « pour plus tard » : ni KEK, ni dérivation, ni poussée de barrière", () => {
  const conduite = conduiteApresLeVerrouillage({ etatConnu: ETATS_DU_VOLUME.ouvert });
  assert.equal(conduite.kekRetenue, false);
  assert.equal(conduite.derivationPermise, false);
  assert.equal(conduite.pousseeDeBarriere, false);
});

test("le cadre est retiré par RECHARGEMENT, et le geste qui rouvre n'est pas offert", () => {
  const conduite = conduiteApresLeVerrouillage({ etatConnu: ETATS_DU_VOLUME.ouvert });
  // L'ASYMÉTRIE avec la mort, assumée et écrite (ADR 0031, décision 1) : après une mort IMPRÉVUE la
  // coquille reste affichée avec son relevé et son bouton « Rouvrir le coffre » — il s'est passé
  // quelque chose, et l'utilisateur doit le voir ; après un verrouillage VOULU elle recharge
  // d'elle-même, parce que les pixels du cadre sont le dernier clair de la session.
  assert.equal(conduite.rechargerLaCoquille, true);
  assert.equal(conduite.gesteQuiRouvreOffert, false);
});

test("le rechargement n'est PAS une réouverture : aucune dérivation sans geste", () => {
  // Ce que le rechargement fait est rejouer le cycle depuis l'étape 1. Ce qu'il ne fait pas est
  // rouvrir : la coquille revient en `verrouille`, l'interface est remontée, et personne n'a agi.
  const conduite = conduiteApresLeVerrouillage({ etatConnu: ETATS_DU_VOLUME.ouvert });
  assert.equal(conduite.reouvertureAutomatique, false);
  assert.equal(conduite.derivationPermise, false);
});

test("l'INSTANTANÉ survit au verrouillage — révision de l'ADR 0024 décision 8", () => {
  // La position par défaut de l'ADR 0024 était « oui, un verrouillage retire l'instantané », et elle
  // invitait #25 à la rouvrir « avec un argument, pas par omission ». L'argument est écrit dans
  // l'ADR 0031 décision 3 : l'instantané est scellé sous la DEK, exactement comme le volume qui
  // reste, lui, sur l'appareil sans que personne n'appelle cela un défaut du verrouillage ; et un
  // verrouillage qui coûte 125,9 s de boot à froid par réouverture est un verrouillage qu'on
  // désactive.
  const conduite = conduiteApresLeVerrouillage({ etatConnu: ETATS_DU_VOLUME.ouvert });
  assert.equal(conduite.instantaneRetire, false);
});

test("la conduite est GELÉE : personne ne la corrige après coup", () => {
  const conduite = conduiteApresLeVerrouillage({ etatConnu: ETATS_DU_VOLUME.ouvert });
  assert.equal(Object.isFrozen(conduite), true);
});

// --- Le DÉLAI d'inactivité, et ses bornes ---------------------------------------------------------

test("le délai par défaut est de DIX MINUTES, et il tient entre ses bornes", () => {
  assert.equal(DELAI_INACTIVITE_MS, 600_000);
  assert.equal(DELAI_INACTIVITE_MINIMUM_MS, 60_000);
  assert.equal(DELAI_INACTIVITE_MAXIMUM_MS, 3_600_000);
  assert.equal(delaiDInactivite(DELAI_INACTIVITE_MS), DELAI_INACTIVITE_MS);
});

test("les BORNES sont tenues par le code, pas par une consigne", () => {
  assert.equal(delaiDInactivite(DELAI_INACTIVITE_MINIMUM_MS), DELAI_INACTIVITE_MINIMUM_MS);
  assert.equal(delaiDInactivite(DELAI_INACTIVITE_MAXIMUM_MS), DELAI_INACTIVITE_MAXIMUM_MS);
  // Sous la minute : un délai qu'on ne peut pas atteindre entre deux frappes n'est pas un
  // verrouillage, c'est une panne.
  assert.match(
    refusDe(() => delaiDInactivite(DELAI_INACTIVITE_MINIMUM_MS - 1)).message,
    /délai d'inactivité/i,
  );
  // Au-delà de l'heure : le délai cesse de borner quoi que ce soit, et la KEK redevient retenue
  // « pour la durée de la session » — exactement ce que cette tranche ferme.
  assert.match(
    refusDe(() => delaiDInactivite(DELAI_INACTIVITE_MAXIMUM_MS + 1)).message,
    /délai d'inactivité/i,
  );
});

test("un délai qui n'est pas un entier de millisecondes est refusé", () => {
  for (const valeur of [Number.NaN, Infinity, "600000", null, undefined, 600_000.5]) {
    assert.match(
      refusDe(() => delaiDInactivite(valeur)).message,
      /délai d'inactivité/i,
      `${String(valeur)} aurait dû être refusé`,
    );
  }
});

test("la surveillance refuse un délai hors bornes à sa CONSTRUCTION", () => {
  // La borne ne vaut que si elle est tenue à l'endroit où la valeur entre dans le produit. La poser
  // seulement dans une fonction que personne n'appelle serait une borne décorative.
  assert.match(
    refusDe(() => surveillanceFeinte({ delaiMs: 30_000 })).message,
    /délai d'inactivité/i,
  );
});

// --- Ce qui compte comme ACTIVITÉ, et ce qui ne compte pas -----------------------------------------

test("les signaux d'activité sont ceux du DOCUMENT de la coquille, et ils sont trois", () => {
  assert.deepEqual([...SIGNAUX_DACTIVITE], ["clavier", "focus", "pointeur"]);
  for (const signal of SIGNAUX_DACTIVITE) assert.equal(estUnSignalDActivite(signal), true);
});

test("les signaux SANS EFFET sont nommés, et non pas absents", () => {
  // Les nommer plutôt que les omettre a une raison : une liste d'exclusion vide est indiscernable
  // d'une liste d'exclusion oubliée, et l'épreuve doit pouvoir les présenter un par un.
  assert.deepEqual([...SIGNAUX_SANS_EFFET], ["barriere", "message-du-cadre", "visibilite"]);
  for (const signal of SIGNAUX_SANS_EFFET) assert.equal(estUnSignalDActivite(signal), false);
});

test("un signal INCONNU ne compte pas non plus : l'activité n'est pas une liste ouverte", () => {
  assert.equal(estUnSignalDActivite("je-suis-la"), false);
  assert.equal(estUnSignalDActivite(""), false);
  assert.equal(estUnSignalDActivite(undefined), false);
});

test("la table des ÉVÉNEMENTS du document ne nomme que le pointeur, le clavier et le focus", () => {
  // Elle vit ici, et non dans la page, pour que la campagne de mutation puisse l'atteindre. Ce
  // qu'elle ne porte PAS est le sujet : aucun événement de cycle de vie de page — `pagehide`,
  // `freeze`, `beforeunload` — n'y figure. Ce sont les fins d'onglet, et elles sont à #170.
  const evenements = Object.keys(EVENEMENTS_DACTIVITE).sort();
  assert.deepEqual(evenements, ["focusin", "keydown", "pointerdown", "pointermove"]);
  for (const signal of Object.values(EVENEMENTS_DACTIVITE)) {
    assert.equal(estUnSignalDActivite(signal), true);
  }
  for (const interdit of ["pagehide", "freeze", "beforeunload", "unload", "visibilitychange"]) {
    assert.equal(
      Object.hasOwn(EVENEMENTS_DACTIVITE, interdit),
      false,
      `${interdit} n'est pas un signal d'activité de cette tranche`,
    );
  }
});

// --- La SURVEILLANCE : quand elle s'arme, quand elle verrouille ------------------------------------

test("le délai n'est armé QUE sur un coffre ouvert", () => {
  const { surveillance, temps } = surveillanceFeinte();
  for (const etat of [
    ETATS_DU_VOLUME.demarrage,
    ETATS_DU_VOLUME.verrouille,
    ETATS_DU_VOLUME.indisponible,
  ]) {
    assert.equal(surveillance.armer(etat), false, `armée sur « ${etat} »`);
    assert.equal(surveillance.armee(), false);
    assert.equal(temps.armees, 0, "une minuterie traîne sur un coffre qui n'est pas ouvert");
  }
  assert.equal(surveillance.armer(ETATS_DU_VOLUME.ouvert), true);
  assert.equal(surveillance.armee(), true);
});

test("un coffre ouvert et LAISSÉ se verrouille à l'échéance, et une seule fois", () => {
  const { surveillance, temps, verrouillages } = surveillanceFeinte();
  surveillance.armer(ETATS_DU_VOLUME.ouvert);
  temps.avancerDe(DELAI_INACTIVITE_MS - 1);
  assert.deepEqual(verrouillages, [], "verrouillé avant l'échéance");
  temps.avancerDe(1);
  assert.deepEqual(verrouillages, [DELAI_INACTIVITE_MS]);
  // Elle se DÉSARME en verrouillant : un second verrouillage sur le même coffre tuerait un Worker
  // qui n'existe plus, et rechargerait une coquille déjà rechargée.
  assert.equal(surveillance.armee(), false);
  temps.avancerDe(DELAI_INACTIVITE_MS * 3);
  assert.equal(verrouillages.length, 1);
});

test("un GESTE de la personne repousse l'échéance ; l'échéance dit de combien", () => {
  const { surveillance, temps, verrouillages } = surveillanceFeinte();
  surveillance.armer(ETATS_DU_VOLUME.ouvert);
  temps.avancerDe(DELAI_INACTIVITE_MS - 1_000);
  assert.equal(surveillance.signaler("clavier"), true);
  assert.equal(surveillance.echeanceMs(), temps.maintenant() + DELAI_INACTIVITE_MS);
  temps.avancerDe(DELAI_INACTIVITE_MS - 1);
  assert.deepEqual(verrouillages, [], "l'échéance n'a pas été repoussée par le geste");
  temps.avancerDe(1);
  assert.equal(verrouillages.length, 1);
});

test("les BARRIÈRES ne comptent pas : un guest qui écrit en boucle n'est pas une personne", () => {
  const { surveillance, temps, verrouillages } = surveillanceFeinte();
  surveillance.armer(ETATS_DU_VOLUME.ouvert);
  for (let tour = 0; tour < 100; tour += 1) {
    temps.avancerDe(DELAI_INACTIVITE_MS / 100);
    assert.equal(surveillance.signaler("barriere"), false);
  }
  // Cent barrières acquittées pendant tout le délai, et l'échéance n'a pas bougé d'une milliseconde.
  assert.equal(verrouillages.length, 1);
  assert.equal(verrouillages[0], DELAI_INACTIVITE_MS);
});

test("aucun message du CADRE ne remet le délai à zéro : le contrat n'admet pas de « je suis là »", () => {
  // L'origine applicative est supposée hostile (#24). Un signal qu'elle pousserait remettrait le
  // délai de verrouillage entre les mains de l'adversaire même que la coquille sépare.
  const { surveillance, temps, verrouillages } = surveillanceFeinte();
  surveillance.armer(ETATS_DU_VOLUME.ouvert);
  for (let tour = 0; tour < 99; tour += 1) {
    temps.avancerDe(DELAI_INACTIVITE_MS / 100);
    assert.equal(surveillance.signaler("message-du-cadre"), false);
    // Ré-armer sur un coffre DÉJÀ armé ne repousse rien non plus : c'est ce que fait la page à
    // chaque réponse d'état, et un délai qui s'y remettrait à zéro ne bornerait jamais rien.
    assert.equal(surveillance.armer(ETATS_DU_VOLUME.ouvert), false);
  }
  assert.deepEqual(verrouillages, [], "verrouillé avant l'échéance");
  temps.avancerDe(DELAI_INACTIVITE_MS / 100);
  assert.deepEqual(verrouillages, [DELAI_INACTIVITE_MS]);
});

test("un document CACHÉ ne remet pas le délai à zéro : le temps continue de courir", () => {
  // `document.hidden` n'est pas de l'activité, et son retour ne l'est pas davantage. Un onglet
  // rangé en arrière-plan pendant dix minutes est exactement le cas que le délai borne.
  const { surveillance, temps, verrouillages } = surveillanceFeinte();
  surveillance.armer(ETATS_DU_VOLUME.ouvert);
  temps.avancerDe(DELAI_INACTIVITE_MS / 2);
  assert.equal(surveillance.signaler("visibilite"), false);
  temps.avancerDe(DELAI_INACTIVITE_MS / 2);
  assert.equal(verrouillages.length, 1);
});

test("un signal reçu sur une surveillance DÉSARMÉE ne l'arme pas", () => {
  const { surveillance, temps, verrouillages } = surveillanceFeinte();
  assert.equal(surveillance.signaler("clavier"), false);
  assert.equal(surveillance.armee(), false);
  temps.avancerDe(DELAI_INACTIVITE_MS * 2);
  assert.deepEqual(verrouillages, []);
});

test("le verrouillage DÉSARME la surveillance, et ne laisse aucune minuterie derrière lui", () => {
  const { surveillance, temps, verrouillages } = surveillanceFeinte();
  surveillance.armer(ETATS_DU_VOLUME.ouvert);
  assert.equal(temps.armees, 1);
  surveillance.desarmer();
  assert.equal(surveillance.armee(), false);
  assert.equal(temps.armees, 0, "une minuterie survit au désarmement");
  temps.avancerDe(DELAI_INACTIVITE_MS * 2);
  assert.deepEqual(verrouillages, []);
});

test("une minuterie qui se réveille TROP TÔT ne verrouille pas : elle se replanifie", () => {
  // Un onglet en arrière-plan voit ses minuteries étirées, et un onglet au premier plan les voit
  // parfois se déclencher tôt. Ce qui décide n'est donc pas le réveil, c'est l'HORLOGE : le
  // verrouillage n'a lieu que si le temps écoulé depuis le dernier signe atteint le délai.
  const { surveillance, temps, verrouillages } = surveillanceFeinte();
  surveillance.armer(ETATS_DU_VOLUME.ouvert);
  temps.avancerDe(DELAI_INACTIVITE_MS / 2);
  surveillance.signaler("pointeur");
  // La minuterie posée à l'armement échoit ici, alors que le dernier signe date de la moitié du
  // délai : elle se replanifie pour le reste au lieu de verrouiller.
  temps.avancerDe(DELAI_INACTIVITE_MS / 2);
  assert.deepEqual(verrouillages, [], "verrouillé sur un réveil, et non sur l'horloge");
  temps.avancerDe(DELAI_INACTIVITE_MS / 2);
  assert.equal(verrouillages.length, 1);
});

test("un délai COURT, pris entre les bornes, verrouille à SON échéance", () => {
  const { surveillance, temps, verrouillages } = surveillanceFeinte({
    delaiMs: DELAI_INACTIVITE_MINIMUM_MS,
  });
  surveillance.armer(ETATS_DU_VOLUME.ouvert);
  temps.avancerDe(DELAI_INACTIVITE_MINIMUM_MS - 1);
  assert.deepEqual(verrouillages, []);
  temps.avancerDe(1);
  assert.deepEqual(verrouillages, [DELAI_INACTIVITE_MINIMUM_MS]);
});

// --- Le GESTE, et l'ORDRE qui est le contrat -------------------------------------------------------

/**
 * Un DOCUMENT feint, réduit à ce que `brancherLesGestesDuCycle` en demande : deux boutons et une
 * ligne d'état. Il retient les écouteurs par identifiant, pour que l'épreuve puisse cliquer.
 */
function documentFeint() {
  const noeuds = new Map();
  const noeud = (identifiant) => {
    if (!noeuds.has(identifiant)) {
      noeuds.set(identifiant, {
        identifiant,
        textContent: "",
        ecouteurs: [],
        addEventListener(_type, geste) {
          this.ecouteurs.push(geste);
        },
      });
    }
    return noeuds.get(identifiant);
  };
  return {
    querySelector: (selecteur) => noeud(selecteur.replace("#", "")),
    cliquer: (identifiant) => noeud(identifiant).ecouteurs.forEach((geste) => geste()),
    texte: (identifiant) => noeud(identifiant).textContent,
  };
}

/** Le journal des gestes, et la liaison minimale que le branchement exige. */
function liaisonFeinte(journal, { rendu = {} } = {}) {
  const racine = documentFeint();
  return {
    racine,
    liaison: {
      racine,
      demander: async (type) => {
        journal.push(`demande:${type}`);
        // Le tour de boucle est ce qui rend l'ordre OBSERVABLE : sans lui, une implémentation qui
        // terminerait le Worker avant d'attendre la réponse passerait pour correcte.
        await Promise.resolve();
        journal.push(`rendu:${type}`);
        return {
          etat: ETATS_DU_VOLUME.verrouille,
          barrieres: 0,
          capture: { retenue: true },
          ...rendu,
        };
      },
      cycle: {
        issueDe: () => null,
        conclure: (etape) => journal.push(`conclue:${etape}`),
        releve: () => [],
      },
      rapport: {},
      publier: () => {},
      apresVerrouillage: () => journal.push("apres-verrouillage"),
    },
  };
}

test("le geste de VERROUILLAGE attend la fermeture du Worker avant de le terminer", async () => {
  // C'est l'ORDRE, et il est le contrat : arrêter la VM → capturer → `await backend.close()` →
  // PUIS `terminate()`. `close()` attend les E/S déjà ACCEPTÉES (#132) et libère le nom du volume ;
  // terminer avant elle laisserait le handle exclusif tenu par un objet que plus personne ne
  // référence, et l'ouverture suivante rendrait `VAULT_STORAGE_BUSY` — sur le volume que
  // l'utilisateur vient de rouvrir lui-même. Ce que coûte l'inverse est mesuré ailleurs :
  // `tests/unit/vm-reouverture-handles.test.mjs` › « MESURE — un SEUL des trois handles encore tenu
  // suffit à rendre « busy » ».
  const journal = [];
  const { liaison } = liaisonFeinte(journal);
  const gestes = brancherLesGestesDuCycle(liaison);
  await gestes.verrouillerLeCoffre();
  const rangDuRendu = journal.indexOf("rendu:fermeture");
  const rangDeLaMort = journal.indexOf("apres-verrouillage");
  assert.ok(rangDuRendu >= 0, "la fermeture n'a jamais été demandée");
  assert.ok(rangDeLaMort > rangDuRendu, "le Worker a été terminé avant la fermeture du volume");
});

test("un verrouillage REFUSÉ ne termine pas le Worker : il n'y a rien à fermer derrière", async () => {
  const journal = [];
  const racine = documentFeint();
  const gestes = brancherLesGestesDuCycle({
    racine,
    demander: () => Promise.reject(Object.assign(new Error("refusé"), { code: "VAULT_X" })),
    cycle: { issueDe: () => null, conclure: () => {}, releve: () => [] },
    rapport: {},
    publier: () => {},
    apresVerrouillage: () => journal.push("apres-verrouillage"),
  });
  const rendu = await gestes.verrouillerLeCoffre();
  assert.equal(rendu.verrouille, false);
  assert.deepEqual(journal, [], "le Worker a été terminé sur une fermeture refusée");
  assert.match(racine.texte("cycle-etat"), /refus/);
});

test("le BOUTON de la coquille est unique, et il s'appelle « verrouiller »", async () => {
  // Un coffre fermé et un coffre verrouillé sont la même chose ; deux mots pour une chose sont un
  // mensonge en attente. `#fermer-le-coffre` a disparu de la coquille avec cette tranche.
  const journal = [];
  const { liaison, racine } = liaisonFeinte(journal);
  brancherLesGestesDuCycle(liaison);
  racine.cliquer("verrouiller-le-coffre");
  await new Promise((rendre) => setTimeout(rendre, 0));
  assert.ok(journal.includes("demande:fermeture"), "le bouton « Verrouiller » ne verrouille pas");
  assert.equal(racine.texte("cycle-etat"), "cycle:coffre-verrouille");
});
