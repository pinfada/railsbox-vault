// Noms partagés par la fixture malveillante et par l'épreuve qui la juge (#161).
//
// Ils vivent dans un module SANS DOM pour que la suite Playwright, qui s'exécute sous Node, puisse
// les importer sans charger la fixture — sinon l'épreuve recopierait des chaînes, et une recopie
// finit toujours par diverger de ce qu'elle décrit.

/** Fichier que la fixture dépose dans l'OPFS qu'elle atteint. Le verdict est rendu ailleurs. */
export const MARQUEUR_OPFS = "hostile-coquille.marker";

/** Base et clé IndexedDB employées par la fixture. Même logique : le verdict est rendu ailleurs. */
export const BASE_IDB = "vault-coquille";
export const MAGASIN_IDB = "sondes";
export const CLE_IDB_HOSTILE = "empreinte-hostile";

/** Contenu écrit par la fixture. Il est cherché depuis l'autre côté de la frontière. */
export const EMPREINTE_HOSTILE = "empreinte-application-malveillante";

/**
 * Où le Worker de confiance range son volume, et comment il le nomme.
 *
 * Ces trois valeurs sont RECOPIÉES et non importées : la fixture joue un adversaire, et un
 * adversaire connaît la géométrie parce que la source est publique — il ne l'apprend pas de nous.
 * Une recopie que rien ne relit finirait par diverger : `tests/unit/coquille-fixture.test.mjs` les
 * confronte à `src/vm/opfs-sync-access.mjs` et à `public/runtime-worker.mjs`.
 */
export const REPERTOIRE_DES_VOLUMES = "vault-volumes";
export const VOLUME_DE_LA_COQUILLE = "coquille";
export const ENVELOPPE_DE_LA_COQUILLE = "coquille.cles";

/** Service Worker que la fixture tente d'enregistrer, et la portée qu'elle réclame. */
export const SERVICE_WORKER_HOSTILE = "./hostile-sw.mjs";

/** Canal de diffusion que la fixture écoute, au cas où la coquille en ouvrirait un. */
export const CANAL_DIFFUSION = "vault-coquille-controle";

/** Nom de verrou que la fixture cherche dans `navigator.locks.query()`. */
export const VERROU_DE_VOLUME = "vault-volume-coquille";

/**
 * Ressource TÉMOIN servie par les deux origines, et les deux contenus possibles.
 *
 * Elle vit sous la portée que le Service Worker de la fixture obtient par défaut. Sur l'origine
 * APPLICATIVE, l'intercepter ne prouve rien de plus que ce que l'ADR 0002 accorde déjà à
 * l'application : sa propre portée. Sur l'origine de la COQUILLE, l'intercepter voudrait dire que
 * du code applicatif répond à la place du serveur de confiance — et c'est exactement ce que le
 * témoin positif fait voir en même origine, faute de quoi « témoin authentique » ne prouverait rien.
 */
export const TEMOIN_CHEMIN = "/coquille-epreuve/temoin.txt";
export const TEMOIN_AUTHENTIQUE = "temoin-authentique";
export const TEMOIN_INTERCEPTE = "temoin-intercepte";

/** Délai au-delà duquel une sonde muette est comptée refusée, plutôt que d'arrêter le relevé. */
export const DELAI_SONDE_MS = 3000;

/**
 * Nombre de sondes que la fixture exécute. Un relevé incomplet est un relevé faux.
 *
 * Trente-huit depuis la revue de la PR #166 : neuf de plus que les vingt-neuf d'origine — une
 * requête concurrente, quatre autour du jeton du harnais, et quatre contre l'encodage (champ en
 * trop, corrélation absente, corrélation dupliquée, transférable sur le port).
 *
 * QUARANTE-SIX depuis #192 : huit de plus, toutes contre le RELAIS HTTP, parce que le type neuf du
 * port restreint porte quatre surfaces qu'une question d'état n'avait pas — une méthode, un chemin,
 * des en-têtes et un corps. La première de ces huit est l'ÉPREUVE ROUGE de la tranche : elle exige
 * non pas un refus quelconque, mais le refus JUSTE.
 *
 * QUARANTE-NEUF depuis #207 : trois de plus, une par geste de portabilité — sauvegarder, restaurer,
 * révoquer en urgence —, posés sur le port restreint et refusés comme types du canal privilégié.
 */
export const NOMBRE_DE_SONDES = 49;
