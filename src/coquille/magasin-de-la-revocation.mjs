// STUB NAÏF (commit rouge, #310) : aucune garde, aucun effet exécuté.
import { etatInitial } from "./phases-de-la-revocation.mjs";
export function creerLaRevocation({ indice } = {}) {
  const etat = etatInitial(indice);
  const ok = () => Object.freeze({ accepte: true, annonce: null });
  return Object.freeze({
    etat: () => etat,
    projection: () => ({}),
    empreinte: () => "",
    occurrence: () => 0,
    accepte: () => true,
    demarrer: ok,
    appliquer: ok,
    modifier: ok,
    definirLIndice: ok,
    terminer: () => {},
    echecs: () => Object.freeze({ entrees: [], perdus: 0 }),
  });
}
