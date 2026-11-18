// ROUGE : la sémantique actuelle — tout `UnknownError` vaut « indisponible » — que les épreuves du
// lot rejettent. Le code vert remplace ce fichier.

export async function racineDeLOpfs(storage = globalThis.navigator?.storage) {
  if (!storage?.getDirectory) {
    return {
      absent: { resultat: "indisponible", detail: "navigator.storage.getDirectory absent" },
    };
  }
  try {
    return { racine: await storage.getDirectory() };
  } catch (erreur) {
    if (erreur?.name === "UnknownError") {
      return {
        absent: {
          resultat: "indisponible",
          detail: "navigator.storage.getDirectory rejeté (UnknownError)",
        },
      };
    }
    return { absent: { resultat: "panne", detail: `${erreur?.name}: ${erreur?.message}` } };
  }
}
