#!/usr/bin/env node
// L'ÉTAPE D'ENVOI chez l'hébergeur, et sa RÉPÉTITION À BLANC (#45, ADR 0017 § 8).
//
//   node tools/publier-envoi.mjs --arbre <dir> --projet <nom-pages> [--profil cloudflare-pages]
//        [--repetition | --envoyer]
//
// Le dépôt ne choisit pas l'hébergeur ; cet outil sait envoyer vers Cloudflare Pages (`wrangler pages
// deploy`), l'hébergeur recommandé sur #31, et ne le fait QUE si on le lui demande ET que les secrets
// existent. Dans tous les autres cas il fait la RÉPÉTITION À BLANC : il mesure les limites de l'hébergeur
// sur l'arbre, affiche exactement ce qui serait envoyé — arbre, projet, commande —, et n'envoie rien.
//
//  - `--repetition` : JAMAIS d'envoi, secrets présents ou non. Les secrets ne sont même pas lus.
//  - `--envoyer`    : envoie si `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID` existent et si les limites
//                     sont respectées (code 7 sinon, rien n'est envoyé). Sans secrets : répétition à blanc.
//
// Le jeton ne transite que par l'environnement du processus fils : il n'est ni écrit, ni passé en argument,
// ni imprimé (seule sa PRÉSENCE l'est). `wrangler` est épinglé à une version exacte ci-dessous.
//
// Codes : 0 répétition faite ou envoi réussi ; 3 usage invalide ; 7 limite d'hébergeur dépassée avec des
// secrets présents ; 8 l'envoi lui-même a échoué.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  controlerLesLimites,
  decrireLesLimites,
  profilNomme,
} from "./publier-limites-hebergeur.mjs";

/** Version EXACTE de wrangler. Ni `latest`, ni plage : un envoi n'est pas rejoué avec un autre outil. */
export const VERSION_DE_WRANGLER = "4.168.0";

export const SECRETS_REQUIS = Object.freeze(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);

const NOM_DE_PROJET = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/;

export const CODES_ENVOI = Object.freeze({ ok: 0, usage: 3, limites: 7, echec: 8 });

/** Les secrets MANQUANTS, par nom — jamais par valeur. Une valeur vide est une absence. */
export function secretsManquants(environnement) {
  return SECRETS_REQUIS.filter((nom) => (environnement[nom] ?? "").trim() === "");
}

/** La commande, telle qu'elle serait exécutée. `--branch main` : la branche de PRODUCTION du projet. */
export function commandeDeWrangler({ arbre, projet }) {
  if (!NOM_DE_PROJET.test(projet ?? "")) {
    throw new Error(
      `Nom de projet Pages invalide : « ${String(projet)} » (minuscules, chiffres, tirets).`,
    );
  }
  return {
    programme: "npx",
    arguments: [
      "--yes",
      `wrangler@${VERSION_DE_WRANGLER}`,
      "pages",
      "deploy",
      arbre,
      "--project-name",
      projet,
      "--branch",
      "main",
    ],
  };
}

/**
 * Décide ce que l'on fait, sans rien exécuter.
 *
 * @returns {{ mode: "repetition" | "envoi", raison: string, manquants: string[] }}
 */
export function decider({ envoyer, environnement }) {
  const manquants = secretsManquants(environnement);
  if (!envoyer) {
    return {
      mode: "repetition",
      raison: "répétition demandée (--repetition) : rien n'est envoyé",
      manquants,
    };
  }
  if (manquants.length > 0) {
    return {
      mode: "repetition",
      raison: `secrets absents (${manquants.join(", ")}) : répétition à blanc, rien n'est envoyé`,
      manquants,
    };
  }
  return { mode: "envoi", raison: "secrets présents et envoi demandé", manquants };
}

function lireOption(argv, nom, defaut = null) {
  const index = argv.indexOf(`--${nom}`);
  if (index < 0) return defaut;
  const valeur = argv[index + 1];
  if (valeur === undefined || valeur.startsWith("--"))
    throw new Error(`L'option --${nom} attend une valeur.`);
  return valeur;
}

async function principal(argv, environnement) {
  const arbre = resolve(lireOption(argv, "arbre") ?? "");
  if (lireOption(argv, "arbre") === null) throw new Error("--arbre est obligatoire.");
  const projet = lireOption(argv, "projet");
  const nomProfil = lireOption(argv, "profil", "cloudflare-pages");
  const profil = profilNomme(nomProfil);
  if (argv.includes("--repetition") && argv.includes("--envoyer")) {
    throw new Error("--repetition et --envoyer s'excluent.");
  }
  const decision = decider({ envoyer: argv.includes("--envoyer"), environnement });
  const commande = commandeDeWrangler({ arbre, projet });
  const limites = await controlerLesLimites(arbre, profil);

  const sortie = [
    `## Envoi de l'arbre ${arbre}`,
    "",
    decision.mode === "envoi"
      ? "MODE : ENVOI RÉEL"
      : `MODE : RÉPÉTITION À BLANC — ${decision.raison}`,
    `projet Pages : ${projet}`,
    `commande     : ${[commande.programme, ...commande.arguments].join(" ")}`,
    `secrets      : ${SECRETS_REQUIS.map((n) => `${n} ${decision.manquants.includes(n) ? "ABSENT" : "présent"}`).join(", ")}`,
    "",
    decrireLesLimites(nomProfil, arbre, limites),
  ];
  const depassements = limites.depassements.length;
  process.stdout.write(`${sortie.join("\n")}\n`);

  if (decision.mode === "repetition") {
    if (depassements > 0) {
      process.stdout.write(
        `\nRÉPÉTITION : ${depassements} dépassement(s) RAPPORTÉ(S) ci-dessus. Un envoi réel serait REFUSÉ (code 7) ` +
          "tant qu'ils subsistent. Ce n'est pas un échec de la répétition : c'est son résultat.\n",
      );
    }
    process.stdout.write("\nRIEN N'A ÉTÉ ENVOYÉ.\n");
    return CODES_ENVOI.ok;
  }
  if (depassements > 0) {
    process.stderr.write(
      `Envoi REFUSÉ : ${depassements} limite(s) de ${nomProfil} dépassée(s). Rien n'a été envoyé.\n`,
    );
    return CODES_ENVOI.limites;
  }
  const fils = spawnSync(commande.programme, commande.arguments, {
    stdio: "inherit",
    env: environnement,
  });
  return fils.status === 0 ? CODES_ENVOI.ok : CODES_ENVOI.echec;
}

if (process.argv[1]?.endsWith("publier-envoi.mjs")) {
  try {
    process.exitCode = await principal(process.argv.slice(2), process.env);
  } catch (erreur) {
    process.stderr.write(`${erreur.message}\n`);
    process.exitCode = CODES_ENVOI.usage;
  }
}
