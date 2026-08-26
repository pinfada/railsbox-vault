// Sondes de FRONTIÈRE de la CSP de la coquille (#52). Chaque sonde tente une chose précise et
// publie ce qui s'est réellement passé — jamais un verdict.
//
// Une leçon du relevé #52, qui commande la forme de ce fichier : un Worker créé depuis une URL
// `blob:` refusée par `worker-src 'self'` ne lève AUCUNE exception. Le constructeur rend un objet,
// et cet objet ne fait rien. Une sonde qui se contenterait d'un `try/catch` conclurait donc
// « autorisé » sur un Worker mort. Les sondes de Worker mesurent par conséquent le SIGNE DE VIE —
// un message reçu dans un délai borné.
//
// Le refus, lui, EST observable, par deux canaux distincts que la sonde consigne tous les deux : un
// événement `securitypolicyviolation` sur le document, et un événement `error` sur le Worker. Ni
// l'un ni l'autre n'est une exception, et aucun des deux n'interrompt le code appelant.

/** Délai accordé à un Worker ou à un script pour donner signe de vie. */
const DELAI_SIGNE_DE_VIE_MS = 2000;

const violations = [];
addEventListener("securitypolicyviolation", (evenement) => {
  violations.push({
    directive: evenement.effectiveDirective,
    bloque: evenement.blockedURI,
  });
});

/** Résout après `DELAI_SIGNE_DE_VIE_MS` avec `valeur`, sauf si la course est gagnée avant. */
const apresDelai = (valeur) =>
  new Promise((resolve) => setTimeout(() => resolve(valeur), DELAI_SIGNE_DE_VIE_MS));

/** Instanciation d'un module WebAssembly minimal : l'en-tête vide, huit octets. */
async function sondeWasm() {
  const octets = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  try {
    const { instance } = await WebAssembly.instantiate(octets, {});
    return instance ? "instancie" : "instance-absente";
  } catch (erreur) {
    return `refuse:${erreur.name}`;
  }
}

/**
 * Attend le premier message d'un Worker, ou déclare le silence.
 *
 * `construire` peut rendre une fonction de LIBÉRATION en plus du Worker : elle n'est appelée
 * qu'après la sonde. C'est ce qui permet de révoquer une URL `blob:` une fois le signe de vie
 * obtenu — ou le délai écoulé — plutôt que dans la foulée de `new Worker`, où un faux refus se
 * lirait comme un refus de CSP (#85).
 */
async function signeDeVie(construire) {
  let worker = null;
  let liberer = () => {};
  try {
    const construit = construire();
    worker = construit.worker ?? construit;
    liberer = construit.liberer ?? liberer;
  } catch (erreur) {
    return `refuse-a-la-construction:${erreur.name}`;
  }
  const vivant = new Promise((resolve) => {
    worker.addEventListener("message", () => resolve("vivant"));
    worker.addEventListener("error", (evenement) => resolve(`erreur:${evenement.message}`));
  });
  const resultat = await Promise.race([vivant, apresDelai("muet")]);
  worker.terminate();
  liberer();
  return resultat;
}

/** Worker servi par l'origine : témoin positif de `worker-src 'self'`. */
const sondeWorkerSelf = () =>
  signeDeVie(() => new Worker("/csp/tick-worker.mjs", { type: "module" }));

/** Worker créé depuis une URL `blob:` : exactement ce que fait la boucle de secours de v86. */
const sondeWorkerBlob = () =>
  signeDeVie(() => {
    const url = URL.createObjectURL(
      new Blob(["self.postMessage('tick')"], { type: "text/javascript" }),
    );
    return { worker: new Worker(url), liberer: () => URL.revokeObjectURL(url) };
  });

/**
 * Charge un script par son URL et dit s'il s'est EXÉCUTÉ. La preuve est l'effet du script, pas
 * l'événement `load` : un script refusé peut ne produire aucun événement du tout.
 */
async function sondeScript(nom, fabriquerUrl) {
  const drapeau = `__vault_${nom}`;
  delete globalThis[drapeau];
  const element = document.createElement("script");
  const url = fabriquerUrl(drapeau);
  element.src = url;
  const execute = new Promise((resolve) => {
    const debut = Date.now();
    const scruter = setInterval(() => {
      if (globalThis[drapeau] === true) {
        clearInterval(scruter);
        resolve("execute");
      } else if (Date.now() - debut > DELAI_SIGNE_DE_VIE_MS) {
        clearInterval(scruter);
        resolve("non-execute");
      }
    }, 25);
  });
  document.head.append(element);
  const resultat = await execute;
  element.remove();
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  return resultat;
}

const sondeScriptBlob = () =>
  sondeScript("blob", (drapeau) =>
    URL.createObjectURL(new Blob([`globalThis.${drapeau}=true`], { type: "text/javascript" })),
  );

const sondeScriptData = () =>
  sondeScript("data", (drapeau) => `data:text/javascript,globalThis.${drapeau}%3Dtrue`);

/** Script INLINE : `script-src 'self'` sans `'unsafe-inline'` doit le refuser. */
async function sondeScriptInline() {
  const drapeau = "__vault_inline";
  delete globalThis[drapeau];
  const element = document.createElement("script");
  element.textContent = `globalThis.${drapeau}=true`;
  document.head.append(element);
  element.remove();
  return globalThis[drapeau] === true ? "execute" : "non-execute";
}

const releve = {
  politiqueMeta:
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
  schedulerPostTask: typeof globalThis.scheduler?.postTask === "function",
  wasm: await sondeWasm(),
  workerSelf: await sondeWorkerSelf(),
  workerBlob: await sondeWorkerBlob(),
  scriptBlob: await sondeScriptBlob(),
  scriptData: await sondeScriptData(),
  scriptInline: await sondeScriptInline(),
  violations,
};

document.querySelector("#resultat").textContent = JSON.stringify(releve, null, 2);
// Le journal reste LU APRÈS coup : certains moteurs délivrent l'événement de violation après la
// fin de la sonde qui l'a provoqué, et le figer dans le texte du relevé en perdrait.
globalThis.releveFrontiere = releve;
document.documentElement.dataset.vaultSondes = "terminees";
