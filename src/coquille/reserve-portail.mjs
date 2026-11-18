// SQUELETTE NAÏF (#299) : le portail autorise toujours, sans rien vérifier.
export function creerLaReserveDeLaPage({ etatPartage = undefined } = {}) {
  return {
    revocation: etatPartage,
    fraicheur: () => undefined,
    async ouvrirLePortail({ creerLeTravailleur }) {
      return { autorise: true, travailleur: creerLeTravailleur(), fraicheur: undefined };
    },
  };
}
