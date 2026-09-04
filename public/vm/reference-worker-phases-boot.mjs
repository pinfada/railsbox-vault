// Phases du Worker de référence qui BOOTENT l'image et vérifient l'invariant (#7, #16, ADR 0005).
//
// Elles délèguent toutes à `bootEtVerifier` et ne se distinguent que par ce qu'elles PROUVENT :
//
//   live          Rails boote sur le disque OPFS en écriture ; l'invariant est vérifié à chaud.
//   resume        BOOT À FROID depuis le même volume OPFS (aucun snapshot), invariant revérifié.
//   live-couper   comme `live`, mais ANNONCE l'instant où le guest a muté et acquitté une barrière.
//   live-capturer comme `live`, mais CAPTURE un instantané au point de contrôle qui clôt le boot.
//   resume-instantane  reprise PAR INSTANTANÉ : l'instantané est ouvert avant le boot, restauré s'il
//                 est utilisable, écarté et retiré sinon — et le boot à froid s'exécute alors.
//   resume-arm/   reprise hors ligne en deux temps : `arm` acquiert le runtime EN LIGNE, le test
//   resume-fire   coupe le réseau, puis `fire` boote à froid et vérifie SANS aucun accès réseau.
//
// Aucune ne se déclare « réussie » d'elle-même : elle rend ce qu'elle a observé, et l'assertion vit
// dans les spécifications de `tests/e2e/`.

import { acquerirRuntime, bootEtVerifier } from "./reference-worker-boot.mjs";

/**
 * État armé de la reprise hors ligne. La reprise se joue en deux temps pour prouver que le RÉSEAU
 * ne participe pas au boot à froid : `resume-arm` acquiert le runtime pendant que la page est en
 * ligne, puis le test coupe le réseau, puis `resume-fire` boote et vérifie SANS aucun accès réseau.
 */
let armed = null;

export async function phaseLive(options) {
  return bootEtVerifier({ ...options, phase: "live" });
}

export async function phaseResume(options) {
  return bootEtVerifier({ ...options, phase: "resume" });
}

/**
 * Boot à chaud qui CAPTURE un instantané (#65, ADR 0024).
 *
 * La capture a lieu au point de contrôle qui clôt le boot, après que l'invariant a été vérifié :
 * capturer avant lierait l'instantané à un état dont personne n'a encore constaté qu'il vaut
 * quelque chose.
 */
export async function phaseLiveCapturer(options) {
  return bootEtVerifier({ ...options, phase: "live-capturer", capturerInstantane: true });
}

/**
 * REPRISE PAR INSTANTANÉ. Elle ne se déclare jamais réussie : elle rend `usedSnapshot` et, quand
 * l'instantané a été écarté, le MOTIF du rejet. Un banc qui dirait « repris » sans distinguer les
 * deux chemins passerait aussi bien avec l'instantané que sans.
 */
export async function phaseResumeInstantane(options) {
  return bootEtVerifier({ ...options, phase: "resume-instantane", reprendreParInstantane: true });
}

/**
 * Boot identique à `live`, mais qui ANNONCE l'instant où le guest a muté le volume et acquitté une
 * barrière (#16). Il ne coupe rien : c'est la PAGE qui ferme, et fermer une page tue son Worker avec
 * son handle exclusif, sans fermeture propre et sans barrière — la coupure la plus réaliste que ce
 * dépôt sache produire sans tuer le navigateur lui-même.
 *
 * Le message d'annonce ne porte AUCUN identifiant de requête : il n'est la réponse de personne. Le
 * banc l'écoute à part, et la promesse de la phase ne se résout jamais si la page coupe — ce qui est
 * exactement ce qu'on veut mesurer.
 */
export async function phaseLiveCouper(options) {
  return bootEtVerifier({
    ...options,
    phase: "live-couper",
    surMutation: (etat) => self.postMessage({ type: "mutation", ...etat }),
  });
}

/** Arme la reprise hors ligne : acquiert le runtime PENDANT que la page est en ligne. */
export async function phaseResumeArm(options) {
  const bundle = await acquerirRuntime(options.runtime);
  armed = { bundle, options };
  return {
    phase: "resume-arm",
    ready: true,
    transferredBytes: bundle.transferredBytes,
    online: navigator.onLine,
  };
}

/** Tire la reprise : boot à froid + vérification, réseau coupé, depuis le runtime déjà en mémoire. */
export async function phaseResumeFire(options) {
  if (armed === null) {
    throw new Error("resume-fire sans resume-arm : le runtime n'a pas été acquis en ligne.");
  }
  const { bundle, options: armedOptions } = armed;
  armed = null;
  return bootEtVerifier({
    ...armedOptions,
    ...options,
    phase: "resume",
    runtimeBundle: bundle,
  });
}
