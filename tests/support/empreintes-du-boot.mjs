// Les EMPREINTES du noyau, de l'initrd et des deux BIOS d'un descripteur d'ÉPREUVE.
//
// `boot.empreintes` est obligatoire : aucun octet de boot n'atteint le guest sans empreinte épinglée
// (revue de sécurité de #298, constat 2 ; ADR 0046). Toute épreuve qui fabrique un descripteur servi
// à la main les prend ici — des valeurs publiques, sans entropie, qui ne protègent rien.

export const EMPREINTES_DU_BOOT_D_EPREUVE = Object.freeze({
  kernel: Object.freeze({ sha256: "1".repeat(64), octets: 6_000_000 }),
  initrd: Object.freeze({ sha256: "2".repeat(64), octets: 9_000_000 }),
  bios: Object.freeze({ sha256: "3".repeat(64), octets: 131_072 }),
  vgaBios: Object.freeze({ sha256: "4".repeat(64), octets: 38_912 }),
});
