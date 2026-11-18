
  const creer = () => {
    const w = new Worker("./worker.mjs", { type: "module" });
    let n = 0;
    const attentes = new Map();
    const evts = [];
    const pret = new Promise((ok) => {
      w.onmessage = ({ data }) => {
        if (data.evt) { evts.push(data.evt); if (data.evt === "pret") ok(); const f = attentes.get(`evt:${data.evt}`); f?.(); return; }
        attentes.get(data.id)?.(data);
      };
    });
    return {
      pret,
      appel: (op, args = {}) => new Promise((ok) => { n += 1; attentes.set(n, ok); w.postMessage({ id: n, op, ...args }); }),
      evenement: (nom) => new Promise((ok) => { if (evts.includes(nom)) ok(); else attentes.set(`evt:${nom}`, ok); }),
      vider: () => { evts.length = 0; },
      tuer: () => w.terminate(),
    };
  };
  globalThis.spike = { creer };
  document.getElementById("etat").textContent = "pret";
