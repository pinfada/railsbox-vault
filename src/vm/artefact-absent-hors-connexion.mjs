// Le refus typé d'un démarrage HORS CONNEXION auquel il manque un artefact (#247, D1g ; ADR 0046).
//
// Il vit côté `src/vm/` — c'est là qu'il est levé. Le registre des codes de la coquille
// (`refus-de-coquille.mjs`, publié à l'origine applicative) porte la MÊME chaîne : `src/vm/` n'importe
// pas la coquille, et la coquille n'importe pas le moteur. L'épreuve
// `vm-acquisition-des-petits-artefacts.test.mjs` les égale.

/** Le code, tel que le registre de la coquille le publie. */
export const CODE_ARTEFACT_ABSENT_HORS_CONNEXION = "VAULT_COQUILLE_HORS_LIGNE_ARTEFACT_ABSENT";

/**
 * @param {string} nom l'artefact qui manque (« rootfs », « kernel », « libv86 »…)
 * @param {string} raison ce qui en est : « manque à la réserve », « n'a pas d'empreinte épinglée »…
 */
export function artefactAbsentHorsConnexion(nom, raison) {
  return Object.assign(
    new Error(
      `Démarrage hors connexion impossible : ${nom} ${raison}, et rien n'est téléchargé hors connexion.`,
    ),
    { code: CODE_ARTEFACT_ABSENT_HORS_CONNEXION, contexte: Object.freeze({ artefact: nom }) },
  );
}
