// Ce que la page SAIT de l'inventaire du coffre, et pourquoi elle ne le sait plus (#265, relecture de
// #308). Porté par le relevé de l'interface (`releve.inventaire`), lu par le parcours :
//
//  - `relu`             la dernière relecture a réussi : moyens, compte de codes et constat sont ceux du coffre ;
//  - `apres-revocation` une révocation a été ACQUITTÉE par le Worker, puis la relecture a échoué ;
//  - `autre`            toute autre relecture échouée (un déverrouillage ordinaire, par exemple).
//
// L'absence de valeur ne vaut JAMAIS `relu` : un relevé sans cause est « non relu ».

export const ETAT_DE_L_INVENTAIRE = Object.freeze({
  relu: "relu",
  apresRevocation: "apres-revocation",
  autre: "autre",
});
