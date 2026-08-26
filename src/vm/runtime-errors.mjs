// Erreurs contractuelles du RUNTIME — l'environnement d'exécution de l'émulateur, par opposition au
// support de stockage dont `storage-errors.mjs` porte les codes. Elles répondent à un défaut
// nommé par l'issue #52 : quand la coquille refuse à v86 ce dont il a besoin, l'émulateur ne
// démarre pas « sans erreur visible ». Un non-démarrage doit avoir un NOM, dans un délai borné.
//
// La forme est délibérément celle de `StorageError` : même préfixe `VAULT_`, même `toJSON()`, même
// discipline — un code inconnu est refusé à la construction, et aucun code ne se dégrade en un
// autre. Les deux séries restent distinctes parce qu'elles désignent des pannes différentes : un
// `VAULT_STORAGE_*` met en cause le volume, un `VAULT_RUNTIME_*` met en cause la coquille qui sert
// le runtime.

export const RUNTIME_ERROR_CODES = Object.freeze({
  /**
   * v86 n'a aucune boucle d'ordonnancement disponible dans ce contexte : ni `scheduler.postTask`
   * (absent du moteur, ou non retenu faute du marqueur d'URL), ni Worker imbriqué.
   */
  schedulingUnavailable: "VAULT_RUNTIME_SCHEDULING_UNAVAILABLE",
  /**
   * Le Worker imbriqué que v86 crée depuis une URL `blob:` ne donne pas signe de vie. Sous
   * `worker-src 'self'`, le constructeur ne lève RIEN : il rend un objet mort. Le refus se
   * manifeste ailleurs — un événement `securitypolicyviolation`, un événement `error` sur le
   * Worker —, jamais par une exception que l'appelant pourrait attraper. Ce code lui donne un nom
   * là où il est utile : au retour de l'appel.
   */
  workerRefused: "VAULT_RUNTIME_WORKER_REFUSED",
  /** L'instanciation d'un module WebAssembly est refusée : la CSP ne nomme pas WebAssembly. */
  wasmRefused: "VAULT_RUNTIME_WASM_REFUSED",
  /**
   * L'émulateur a été construit mais sa boucle n'a jamais avancé dans le délai imparti. Filet de
   * sécurité du contrôle préalable : il attrape les causes que celui-ci n'a pas su prédire.
   */
  noTick: "VAULT_RUNTIME_NO_TICK",
  /**
   * Le compteur de tours de v86 n'a jamais été lisible. C'est une OBSERVATION, jamais une panne :
   * elle dit que le chien de garde a perdu son instrument, pas que l'émulateur s'est arrêté.
   */
  ticksUnreadable: "VAULT_RUNTIME_TICKS_UNREADABLE",
  /**
   * Une promesse a été rejetée sans que personne ne l'observe dans le Worker runtime. C'est une
   * OBSERVATION, non fatale, et elle vaut d'être publiée : v86 n'attend PAS la promesse rendue par
   * `scheduler.postTask`, si bien qu'une exception levée dans son rappel de tour arrête l'émulateur
   * en silence et se déguise ensuite en délai de garde du guest.
   */
  unhandledRejection: "VAULT_RUNTIME_UNHANDLED_REJECTION",
});

const CODES_CONNUS = new Set(Object.values(RUNTIME_ERROR_CODES));

/** Erreur typée du runtime : un code stable, un message français, un contexte sérialisable. */
export class RuntimeError extends Error {
  /**
   * @param {string} code une valeur de `RUNTIME_ERROR_CODES`
   * @param {string} message message destiné à l'exploitant, en français
   * @param {Record<string, unknown>} [context] contexte structuré, sans donnée utilisateur
   */
  constructor(code, message, context = {}) {
    if (!CODES_CONNUS.has(code)) {
      throw new Error(`Code d'erreur de runtime inconnu : ${code}`);
    }
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }

  /** Forme transportable par `postMessage` : une erreur ne doit pas se perdre au passage du port. */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, context: this.context };
  }
}

/** Vrai si `value` est une erreur de runtime portant `code`. */
export function isRuntimeError(value, code) {
  return value instanceof RuntimeError && (code === undefined || value.code === code);
}

/** La CSP du contexte ne nomme pas WebAssembly : v86 ne peut pas charger son cœur. */
export function wasmRefused(cause) {
  return new RuntimeError(
    RUNTIME_ERROR_CODES.wasmRefused,
    `L'instanciation d'un module WebAssembly est refusée dans ce contexte (${cause}). La CSP de la coquille doit porter « 'wasm-unsafe-eval' » dans « script-src ». Voir l'ADR 0013.`,
    { cause },
  );
}

/**
 * v86 aurait emprunté sa boucle de secours — un Worker imbriqué créé depuis une URL `blob:` — et ce
 * Worker ne donne pas signe de vie. C'est le symptôme central de #52 : sans ce code, l'émulateur se
 * contenterait de ne jamais battre.
 */
export function workerRefused({ raison, observation }) {
  return new RuntimeError(
    RUNTIME_ERROR_CODES.workerRefused,
    `v86 emprunterait sa boucle de secours (Worker imbriqué « blob: ») parce que ${raison}, et ce Worker ne donne pas signe de vie (${observation}) : la CSP de la coquille sert « worker-src 'self' ». Charger le Worker runtime avec « ?use-scheduling-api » : depuis #74, Vault fournit lui-même la boucle « scheduler.postTask », y compris sur un moteur qui ne l'expose pas. Voir l'ADR 0013 et docs/compatibility.md.`,
    { raison, observation },
  );
}

/**
 * Une promesse rejetée que personne n'observait. Ce n'est PAS une panne du runtime : c'est une
 * observation publiée dans le compte rendu. Elle existe parce que v86 jette la valeur de retour de
 * `scheduler.postTask` — une exception dans son rappel de tour n'atteint donc aucun `try` du dépôt,
 * arrête l'émulateur sans bruit, et se déguise ensuite en délai de garde du guest.
 */
export function unhandledRejection({ raison }) {
  return new RuntimeError(
    RUNTIME_ERROR_CODES.unhandledRejection,
    `Une promesse a été rejetée sans être observée dans ce Worker : ${raison}. v86 n'attend pas la promesse de « scheduler.postTask » : si ce rejet vient d'un tour de boucle, l'émulateur s'est arrêté là, et tout délai de garde ultérieur accuserait le GUEST à tort.`,
    { raison },
  );
}

/** Aucun des deux chemins d'ordonnancement de v86 n'est utilisable dans ce contexte. */
export function schedulingUnavailable({ raison, observation }) {
  return new RuntimeError(
    RUNTIME_ERROR_CODES.schedulingUnavailable,
    `Aucune boucle d'ordonnancement n'est disponible pour v86 : ${raison} (${observation}). Voir l'ADR 0013 et docs/compatibility.md.`,
    { raison, observation },
  );
}

/**
 * Ce que la boucle d'ordonnancement posée par Vault apprend sur un compteur figé. Le nombre de
 * tâches qu'elle a reçues sépare deux pannes que rien d'autre ne distingue : v86 emprunte-t-il
 * cette boucle, ou une autre ?
 */
function verdictSurLaBoucle(boucle) {
  if (!boucle) return "";
  if (boucle.appels > 0) {
    return ` La boucle d'ordonnancement posée par Vault (« ${boucle.source} ») a reçu ${boucle.appels} tâche(s) : v86 l'emprunte bien, et la panne est donc ailleurs.`;
  }
  return ` La boucle d'ordonnancement posée par Vault (« ${boucle.source} ») n'a reçu AUCUNE tâche : v86 ne l'emprunte pas. Cause la plus probable : l'URL de ce Worker ne contient pas « use-scheduling-api ». Autres causes possibles, et à écarter dans cet ordre : la boucle a été posée APRÈS l'import de « libv86.mjs » (v86 fige son chemin à l'évaluation de son module), ou une montée de version de v86 a changé la condition qu'il teste — voir docs/development.md § « Monter v86 de version ».`;
}

/**
 * L'émulateur existe, son compteur de tours est LISIBLE, et il n'a pas bougé dans le délai imparti.
 * `ticks` porte donc toujours un nombre : un compteur illisible relève de `ticksUnreadable`, qui
 * n'est pas une panne.
 *
 * `boucle` est la forme sérialisable de la boucle d'ordonnancement posée par Vault (#74), ou `null`
 * quand l'appelant n'en a pas posé. Elle n'est pas décorative : sans elle, le message devrait
 * DEVINER pourquoi un émulateur muni d'une boucle ne bat pas.
 */
export function noTick({ delaiMs, ticks, boucle = null }) {
  return new RuntimeError(
    RUNTIME_ERROR_CODES.noTick,
    `L'émulateur n'a effectué aucun tour de boucle en ${delaiMs} ms (compteur figé à ${ticks}).${verdictSurLaBoucle(boucle)} Le contrôle préalable n'a donc pas prédit cette panne : c'est un fait à consigner dans l'ADR 0013 avant de conclure.`,
    { delaiMs, ticks, boucle },
  );
}

/**
 * Le compteur de tours n'a jamais rendu de nombre. Cette observation ne fait échouer aucun boot :
 * un émulateur SAIN dont le compteur a été renommé par une montée de v86 doit continuer de démarrer.
 * Elle est consignée dans le compte rendu pour que la perte d'instrument soit visible — un chien de
 * garde muet qui ne le dit pas serait exactement le silence que #52 combat.
 */
export function ticksUnreadable({ delaiMs }) {
  return new RuntimeError(
    RUNTIME_ERROR_CODES.ticksUnreadable,
    `Le compteur de tours de v86 (« tick_counter ») n'a rendu aucun nombre en ${delaiMs} ms : le chien de garde du premier tour est SANS EFFET pour cette exécution. Le boot n'en est pas empêché. Cause probable : une montée de v86 dont la compilation Closure ne conserve plus ce nom — voir l'ADR 0003 § « Coût de mise à jour de v86 ».`,
    { delaiMs },
  );
}
