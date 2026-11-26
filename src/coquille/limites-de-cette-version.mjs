// Ce que cette version ne promet pas, dit à la personne sur l'écran d'entrée (#195, publication,
// étape 4 du 26/11/2026).
//
// Ces textes DÉCLARENT : ils ne corrigent rien. Chaque chiffre vient de `docs/quality-attributes.md`, et
// la page de détail (`docs/limites-de-cette-version.md`) donne sa valeur exacte, son environnement et sa
// date ; l'épreuve `coquille-limites-de-l-entree.test.mjs` exige que tout chiffre dit ici s'y retrouve.
// Un chiffre qui change se change ici ET dans la page de détail, puis `node tools/relecture-parcours.mjs`
// régénère la page de relecture. Le palier d'usage n'est pas redéfini ici : `docs/vision.md` et
// `SECURITY.md` (§ « Gates d'utilisation ») font foi.

const LIEN_DU_DETAIL =
  "https://github.com/pinfada/railsbox-vault/blob/main/docs/limites-de-cette-version.md";

export const LIMITES = Object.freeze({
  titre: "Ce que cette version ne promet pas",
  limites: Object.freeze([
    Object.freeze({
      cle: "chromium",
      titre: "Chrome ou Edge seulement",
      texte:
        "Utilisez Chrome ou Edge récents, sur ordinateur. Dans Firefox, l'application ne démarre " +
        "pas. Safari n'est pas pris en charge.",
    }),
    Object.freeze({
      cle: "premier-demarrage",
      titre: "Un premier démarrage long",
      texte:
        "Le premier démarrage dure environ deux minutes : de 82 à 126 secondes mesurées, sur des " +
        "machines de test. Sur un portable modeste ou un téléphone, ce n'est pas mesuré.",
    }),
    Object.freeze({
      cle: "telechargement",
      titre: "Un gros téléchargement",
      texte:
        "Le premier démarrage télécharge environ 200 Mo. Évitez une connexion limitée en volume.",
    }),
    Object.freeze({
      cle: "memoire",
      titre: "Beaucoup de mémoire",
      texte:
        "L'application réserve 512 Mo pour elle seule. Le navigateur a dépassé 1,5 Go au plus fort " +
        "du démarrage, au-delà de la cible de 1,2 Go. Fermez vos autres onglets.",
    }),
    Object.freeze({
      cle: "donnees",
      titre: "Données non sensibles seulement",
      texte:
        "N'y mettez aucune donnée réelle ni sensible. Cette version sert à essayer, pas à garder " +
        "des secrets.",
    }),
    Object.freeze({
      cle: "paquet",
      titre: "Une application non signée",
      texte:
        "L'application n'est pas signée : rien ne prouve encore que le code reçu est bien celui " +
        "que l'auteur a publié. La signature est prévue plus tard (jalon 6).",
    }),
    Object.freeze({
      cle: "hors-connexion",
      titre: "Hors connexion, après un premier démarrage",
      texte:
        "Le premier démarrage a besoin d'Internet. Ensuite, l'application redémarre sans " +
        "connexion, mais elle ne peut pas savoir si une nouvelle version existe.",
    }),
  ]),
  detail: Object.freeze({
    libelle: "Les chiffres et leurs sources",
    lien: LIEN_DU_DETAIL,
  }),
});

/**
 * Les écrans qui montrent les limites : la CRÉATION, et elle seule. Les limites se disent avant que la
 * personne crée quoi que ce soit ; à la réouverture elle les a déjà lues, et le champ de la phrase doit
 * rester à l'écran (ADR 0043, R1-bis). Elles sont écrites dans la promesse de l'entrée : cet écran est
 * donc aussi un écran de `ECRANS_DE_L_ENTREE` (épreuve `coquille-limites-de-l-entree.test.mjs`).
 */
export const ECRANS_DES_LIMITES = Object.freeze(["creer"]);

/** Vrai si l'écran montre les limites. La page applique ce verdict, elle ne le décide pas. */
export function limitesAffichees(ecranId) {
  return ECRANS_DES_LIMITES.includes(ecranId);
}
