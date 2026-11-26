// Les QUESTIONS que la page pose au Service Worker de la coquille (#299, ADR 0048 § 7) : un
// `MessageChannel` par question, une réponse bornée. Rien de ce qui passe ici n'est une clé ni une donnée
// du volume : des versions, des empreintes, des chemins.

/** Valeurs de départ, À CALIBRER en D1h-b sans jamais être abaissées sans mesure (ADR 0048 § 7). */
export const DELAIS_PAR_DEFAUT = Object.freeze({
  /** Borne de la réponse à `version`, `verifier`, `clients`. */
  delaiReponseMs: 3_000,
  /** Borne de la fraîcheur (`update()` ET installation). Serré sous Firefox (installation nominale : 2 à 3,4 s). */
  delaiVerificationMs: 5_000,
  /** Borne de l'installation INITIALE : une page qui attend l'activation sans borne bloque son `load` sous Firefox. */
  delaiInstallationInitialeMs: 25_000,
  /** Borne de la RÉPARATION (`reparer` retélécharge les entrées abîmées). */
  delaiReparationMs: 60_000,
  /**
   * Délai de GRÂCE après un `update()` résolu sans Worker installant visible : la navigation a pu lancer sa
   * propre mise à jour, que `update()` rejoint avant que `updatefound` ne soit dit (mesuré sous Chromium :
   * une version en attente révoquée n'était vue qu'après la décision). Sans lui, le portail décide trop tôt ;
   * l'observateur permanent annonce alors après coup, sans interrompre la session (ADR 0048 § 8).
   */
  delaiDeGraceMs: 400,
  /** Borne de la poignée de main du Worker de confiance. */
  delaiAnnonceMs: 8_000,
});

/**
 * Pose une question au Service Worker `cible` ; rend sa réponse (un objet), ou `null` si rien n'arrive avant
 * le délai. Ne rejette jamais.
 *
 * @param {{ postMessage(message: unknown, transferts: unknown[]): void }} cible
 * @param {string} type
 * @param {number} delaiMs
 * @returns {Promise<Record<string, unknown> | null>}
 */
export function interroger(cible, type, delaiMs) {
  return new Promise((resoudre) => {
    const canal = new MessageChannel();
    const finir = (valeur) => {
      clearTimeout(minuterie);
      canal.port1.close();
      resoudre(valeur);
    };
    const minuterie = setTimeout(() => finir(null), delaiMs);
    canal.port1.onmessage = (evenement) => {
      const donnees = evenement.data;
      finir(
        donnees !== null && typeof donnees === "object" && !Array.isArray(donnees) ? donnees : null,
      );
    };
    try {
      cible.postMessage({ type }, [canal.port2]);
    } catch {
      finir(null);
    }
  });
}

/** Une promesse qui se règle à `valeur` après `delaiMs`. */
export const apresUnDelai = (delaiMs, valeur) =>
  new Promise((resoudre) => setTimeout(() => resoudre(valeur), delaiMs));
