// SQUELETTE NAÏF (#299) : un état qui oublie.
export function creerEtatPartage() {
  let connue = false;
  return {
    connue: () => connue,
    cause: () => null,
    noter() {
      connue = true;
    },
    effacer() {
      connue = false;
    },
    controleurChange: () => false,
    noterLeChangementDeControleur() {},
  };
}
