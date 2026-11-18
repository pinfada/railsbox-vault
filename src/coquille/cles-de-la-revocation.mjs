// Le CATALOGUE FERMÉ des clés de texte de la révocation, chacune ÉTIQUETÉE de ce qu'elle AFFIRME
// (#310, ADR 0049, I3). Aucun texte final ici : C2 associe un texte à chaque clé et vérifie l'étiquette.
//
// Étiquettes : `aucune` (n'affirme rien du coffre) ; `revoque` (« révoqué » dicible : l'acquit du
// Worker de CETTE instance) ; `peut-etre` (« a peut-être eu lieu ») ; `seance` (« aucun geste de
// révocation dans cette séance », vrai par construction) ; `non-lancee` (« la demande n'a pas été
// lancée », vrai : l'exécuteur n'a pas été appelé).
//
// Il n'existe AUCUNE clé « refusée », « rien n'a été révoqué » ni « tous vos moyens ouvrent toujours »
// (D4, I3) : elles ne sont pas dicibles, et leur absence est éprouvée.

export const ETIQUETTES = Object.freeze({
  aucune: "aucune",
  revoque: "revoque",
  peutEtre: "peut-etre",
  seance: "seance",
  nonLancee: "non-lancee",
});

const cle = (affirme) => Object.freeze({ affirme });

export const CLES_DE_TEXTE = Object.freeze({
  chargement: cle(ETIQUETTES.aucune),
  "chargement-apres-revocation": cle(ETIQUETTES.revoque),
  "modification-en-cours": cle(ETIQUETTES.aucune),
  "modification-en-cours-apres-revocation": cle(ETIQUETTES.revoque),
  relire: cle(ETIQUETTES.aucune),
  "relire-apres-revocation": cle(ETIQUETTES.revoque),
  "revoquer-en-cours": cle(ETIQUETTES.peutEtre),
  "revocation-en-cours": cle(ETIQUETTES.peutEtre),
  "revocation-incertaine": cle(ETIQUETTES.peutEtre),
  termine: cle(ETIQUETTES.revoque),
  "termine-sans-attestation": cle(ETIQUETTES.aucune),
  "termine-sans-revoquer": cle(ETIQUETTES.seance),
  annulee: cle(ETIQUETTES.seance),
  "envoi-annule-affichage": cle(ETIQUETTES.seance),
  "lancement-annule-affichage": cle(ETIQUETTES.nonLancee),
  "indice-non-ecrit": cle(ETIQUETTES.revoque),
  "demande-refusee-en-cours": cle(ETIQUETTES.peutEtre),
  "demande-refusee-a-verifier": cle(ETIQUETTES.peutEtre),
  "demande-refusee-deja-faite": cle(ETIQUETTES.revoque),
  "demande-refusee-donnees-inconnues": cle(ETIQUETTES.aucune),
  "geste-refuse": cle(ETIQUETTES.aucune),
  "affichage-non-a-jour": cle(ETIQUETTES.aucune),
});
