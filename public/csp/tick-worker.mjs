// Témoin POSITIF de `worker-src 'self'` : un Worker servi par l'origine de la coquille, donc admis.
// Sans lui, un relevé où tous les Workers se taisent ne distinguerait pas « la CSP refuse » de
// « le banc est cassé ».

self.postMessage("tick");
