// Réassemblage de la sortie d'une commande shell lue sur la console série du guest.
//
// Pur : ni v86, ni Node, ni DOM. Il transforme un flux d'octets série en la sortie d'une commande,
// ce qui le rend vérifiable par `tests/unit/serial-console.test.mjs` sans démarrer de VM — au même
// titre que le codec de `tools/vm/serial-protocol.mjs`.

/** Invite du shell BusyBox de l'image `linux4.iso`. */
export const GUEST_PROMPT = "~%";

/**
 * Construit la ligne envoyée au guest pour exécuter une commande et borner sa sortie.
 *
 * Le jeton de fin est écrit `R""B<n>` : le shell retire les guillemets, donc l'écho de la commande
 * montre `R""B<n>` tandis que la SORTIE de `echo` montre `RB<n>`. Attendre `RB<n>` évite ainsi de
 * confondre l'écho de la commande avec son résultat.
 *
 * @param {string} command
 * @param {number} sequence
 * @returns {string}
 */
export function buildCommandFrame(command, sequence) {
  return `${command}; echo R""B${sequence}\n`;
}

/** Jeton de fin présent dans la SORTIE (`echo` a retiré les guillemets), pas dans l'écho. */
export const endToken = (sequence) => `RB${sequence}`;

/**
 * Séquence de repli du terminal du guest.
 *
 * Mesuré en bootant `linux4.iso` : au-delà de 80 colonnes, le terminal insère un DOUBLE retour
 * chariot suivi d'un saut de ligne (`\r\r\n`) pour reporter la suite d'une ligne logique — une
 * marque de repli, distincte du `\r\n` (retour chariot SIMPLE) d'une vraie fin de ligne. La
 * distinction est le point d'appui du réassemblage : le repli se retire, la vraie fin se garde.
 */
const TERMINAL_WRAP = /\r\r\n/g;

/**
 * Réassemble la sortie d'une commande à partir du flux série accumulé.
 *
 * Le réassemblage est INDÉPENDANT de la largeur du terminal : on retire d'abord les marques de
 * repli `\r\r\n`, ce qui recolle chaque ligne logique — écho comme sortie — quel que soit le nombre
 * de fois qu'elle a été repliée et à quelle colonne. Sans ce recollage, un jeton scindé par le
 * repli devient introuvable (l'écho est alors pris pour la sortie) et une ligne de sortie longue
 * garde un `\r\n` parasite.
 *
 * @param {string} transcript
 * @param {number} sequence
 * @returns {string}
 */
export function reassembleCommandOutput(transcript, sequence) {
  const token = endToken(sequence);
  const lines = transcript
    .replace(TERMINAL_WRAP, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  // Le résultat est ce qui sépare la FIN de l'écho de la commande du jeton. L'écho, une fois
  // recollé, tient sur une seule ligne : on le borne par la marque `R""B`, présente dans l'écho
  // (guillemets inclus) et absente de la sortie.
  const start = lines.findIndex((line) => line.includes('R""B')) + 1;
  const end = lines.findIndex((line, index) => index >= start && line.includes(token));
  return lines
    .slice(start, end < 0 ? undefined : end)
    .filter((line) => !line.startsWith(GUEST_PROMPT))
    .join("\n")
    .trim();
}
