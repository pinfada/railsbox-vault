// La PREMIÈRE INSTALLATION et le cas « sans contrôleur » du portail de la réserve (#299, ADR 0048 § 7,
// étape 2). Ce n'est PAS un refus : « Préparation hors connexion, une seule fois » (installation, puis un
// rechargement automatique), bornée ; un échec (quota, refus du navigateur) devient `RESERVE_ABSENTE`.
// Le démarrage n'a pas lieu sur une réserve partielle.

import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";
import { ETATS_DE_FRAICHEUR as E } from "./reserve-fraicheur.mjs";
import { URL_DU_SW } from "./reserve-identite.mjs";
import { apresUnDelai, interroger } from "./reserve-questions.mjs";

const refuser = (code, cause, fraicheur) => ({ autorise: false, code, cause, fraicheur });

/** Attend l'activation du Worker (bornée) : `activee`, `redondante` ou `delai`. */
function attendreLActivation(worker, delaiMs) {
  return Promise.race([
    new Promise((resoudre) => {
      const verifier = () => {
        if (worker.state === "activated") resoudre("activee");
        else if (worker.state === "redundant") resoudre("redondante");
      };
      worker.addEventListener("statechange", verifier);
      verifier();
    }),
    apresUnDelai(delaiMs, "delai"),
  ]);
}

/** « Préparation hors connexion, une seule fois » : inscrire, attendre l'activation (bornée), recharger. */
async function premiereInstallation({ conteneur, existante, delais }) {
  const impossible = refuser(C.reserveAbsente, "installation-impossible", E.NON_VERIFIABLE);
  let inscription;
  try {
    inscription =
      existante ?? (await conteneur.register(URL_DU_SW, { scope: "/", updateViaCache: "none" }));
  } catch {
    return impossible;
  }
  const worker = inscription?.installing ?? inscription?.waiting ?? inscription?.active;
  if (!worker) return impossible;
  const issue = await attendreLActivation(worker, delais.delaiInstallationInitialeMs);
  return issue === "activee"
    ? { autorise: false, recharger: true, cause: "premiere-installation" }
    : impossible;
}

/**
 * Sans contrôleur : un script de retrait lu sur l'inscription ACTIVE (Firefox ne lui donne aucun
 * contrôleur) ; une inscription active sans contrôle ; sinon la première visite.
 */
export async function sansControleur({ conteneur, etatPartage, delais }) {
  const inscription = await conteneur.getRegistration("/").catch(() => undefined);
  if (inscription?.active) {
    const identite = await interroger(inscription.active, "version", delais.delaiReponseMs);
    if (identite?.retrait === true) {
      etatPartage.noter("retrait");
      return refuser(C.reservePerimee, "retrait", E.REVOCATION_CONNUE);
    }
    return refuser(C.reserveAbsente, "inscription-sans-controle", E.NON_VERIFIABLE);
  }
  return premiereInstallation({ conteneur, existante: inscription, delais });
}
