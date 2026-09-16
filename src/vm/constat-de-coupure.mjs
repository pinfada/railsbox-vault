// Observation du BANC après la mort du Worker et AVANT toute récupération (#222).
// Les racines ne sont ici que décodées, PAS authentifiées. Ce constat n'autorise aucune ouverture :
// le boot suivant doit authentifier le journal, le rejouer et rendre l'invariant Rails conforme.
import { constaterOuverture } from "./generation-recuperation.mjs";
import { longueurPhysiqueDeCharge } from "./generation-format.mjs";

/** Lit seulement les racines et la taille, jamais la charge entière ; ne modifie pas le journal. */
export function constaterLaCoupure({ journal, tailleVolume }) {
  const { racine, abimees, chargePresente } = constaterOuverture({ journal, tailleVolume });
  if (racine === null || abimees !== 0) {
    throw new Error("Constat de coupure impossible : racine absente ou abîmée.");
  }
  const chargeValidee = longueurPhysiqueDeCharge(racine);
  if (chargePresente < chargeValidee) {
    throw new Error("Constat de coupure impossible : charge validée tronquée.");
  }
  return {
    generation: racine.generation,
    sequence: racine.sequence,
    enregistrementsValides: racine.nombreEntrees,
    chargePresente,
    chargeValidee,
    octetsNonValides: chargePresente - chargeValidee,
  };
}
