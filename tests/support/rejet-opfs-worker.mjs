// Pose, dans le Worker de confiance, un `getDirectory()` dont les rejets sont TENUS PAR L'ÉPREUVE (#231).
//
// `addInitScript` n'atteint pas les Workers : la route du script du Worker lui ajoute un préambule. Le
// préambule interroge à chaque appel un interrupteur de même origine que la route de l'épreuve sert —
// un compte d'appels fixé d'avance serait faux dès qu'un autre module du Worker appelle `getDirectory()`
// avant la sonde.
//
//  - `etat.rejeter` : vrai, tout appel rejette `UnknownError` ;
//  - `etat.laisserPasser` : N appels aboutissent, puis les suivants rejettent (la sonde réussit, la
//    lecture qui suit échoue : la panne APRÈS une sonde réussie).

export async function poserLeRejetDansLeWorker(context, etat) {
  await context.route(/\/__rejets-d-opfs$/, (route) => {
    let rejeter = etat.rejeter === true;
    if (!rejeter && Number.isInteger(etat.laisserPasser)) {
      if (etat.laisserPasser > 0) etat.laisserPasser -= 1;
      else rejeter = true;
    }
    return route.fulfill({ status: 200, contentType: "text/plain", body: rejeter ? "1" : "0" });
  });
  await context.route(/\/runtime-worker\.mjs/, async (route) => {
    const reponse = await route.fetch();
    const prelude =
      "const __origine = StorageManager.prototype.getDirectory;\n" +
      "StorageManager.prototype.getDirectory = async function () {\n" +
      '  const demande = await (await fetch("/__rejets-d-opfs", { cache: "no-store" })).text();\n' +
      '  if (demande === "1") throw new DOMException("transitoire", "UnknownError");\n' +
      "  return __origine.call(this);\n" +
      "};\n";
    await route.fulfill({ response: reponse, body: prelude + (await reponse.text()) });
  });
}
