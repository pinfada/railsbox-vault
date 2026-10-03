// La taille d'une sauvegarde, dite en clair à la personne (#269).

const OCTETS_PAR_MEGAOCTET = 1024 * 1024;

/** Une taille en Mo entiers, jamais moins de 1 : « 512 » pour le disque par défaut. */
export function enMegaoctets(octets) {
  return Math.max(1, Math.round(octets / OCTETS_PAR_MEGAOCTET));
}
