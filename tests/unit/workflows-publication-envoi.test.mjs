// CLIQUETS de l'étape d'envoi de `publication.yml` (#45) : elle reste INERTE par construction.
//
// Ce que ces épreuves tiennent : (1) l'envoi n'a lieu que dans `deployer`, derrière `envoyer` et l'environnement
// `production` ; (2) la répétition à blanc ne référence NI secret NI environnement ; (3) un secret n'est lu que
// par `env:` de l'étape d'envoi, jamais dans un `run:` ; (4) wrangler n'est appelé que par l'outil épinglé ;
// (5) la chaîne construit l'arbre AVEC l'image et prouve le démarrage sur l'arbre publié seul.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publication = (
  await readFile(new URL("../../.github/workflows/publication.yml", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const job = (id) =>
  publication.match(
    new RegExp(`^ {2}${id}:\\n(?<b>[\\s\\S]*?)(?=^ {2}[\\w-]+:|(?![\\s\\S]))`, "mu"),
  )?.groups.b;

test("le déclenchement reste workflow_dispatch SEUL", () => {
  assert.match(publication, /^on:\n {2}workflow_dispatch:/mu);
  assert.doesNotMatch(publication, /^ {2}(?:push|pull_request|schedule|release):/mu);
});

test("deployer : environnement production, envoi demandé, après la publication", () => {
  const bloc = job("deployer");
  assert.ok(bloc, "le job deployer existe");
  assert.match(bloc, /^ {4}environment: production$/mu);
  assert.match(bloc, /^ {4}if: \$\{\{ inputs\.envoyer \}\}$/mu);
  assert.match(bloc, /^ {4}needs: publier$/mu);
  assert.match(bloc, /publier-envoi\.mjs --envoyer/u);
});

test("deployer : UN seul appel d'envoi pour les DEUX arbres, précédé de la garde de l'environnement", () => {
  const bloc = job("deployer");
  assert.equal(
    (bloc.match(/publier-envoi\.mjs/gu) ?? []).length,
    1,
    "un appel : les deux cibles sont contrôlées avant tout envoi",
  );
  assert.equal((bloc.match(/--cible /gu) ?? []).length, 2);
  assert.ok(bloc.indexOf("publier-garde-environnement.mjs") !== -1, "la garde existe");
  assert.ok(
    bloc.indexOf("publier-garde-environnement.mjs") < bloc.indexOf("publier-envoi.mjs"),
    "la garde précède l'envoi",
  );
  assert.ok(
    bloc.indexOf("artifacts/publication/application=") <
      bloc.indexOf("artifacts/publication/coquille="),
    "l'application d'abord",
  );
  // La garde ne reçoit AUCUN secret : son étape n'a que le jeton du workflow.
  const debut = bloc.indexOf("- name: Garde de l'environnement");
  const etape = bloc.slice(debut, bloc.indexOf("- name:", debut + 5));
  assert.ok(etape.includes("publier-garde-environnement.mjs"), "l'étape de garde est isolée");
  assert.doesNotMatch(etape, /CLOUDFLARE|secrets\./u);
  // L'approbation de CE run, lue avec le jeton du workflow : `contents: read` suffit (mesuré, 26/11/2026),
  // le job n'a aucune permission de plus. Absente, la lecture rend `[]` : refus fermé.
  assert.match(etape, /actions\/runs\/\$VAULT_RUN\/approvals/u);
  assert.match(etape, /VAULT_RUN: \$\{\{ github\.run_id \}\}/u);
  assert.match(etape, /publier-garde-environnement\.mjs environnement\.json approbations\.json/u);
  assert.doesNotMatch(
    bloc,
    /^ {4}permissions:/mu,
    "aucune permission de job : contents: read hérité",
  );
  assert.match(publication, /^permissions:\n {2}contents: read$/mu);
  assert.match(
    etape,
    /\|\| echo '\[\]' > approbations\.json/u,
    "lecture en échec = aucune approbation",
  );
  assert.match(etape, /\|\| echo '\{\}' > environnement\.json/u, "lecture en échec = aucune règle");
  assert.doesNotMatch(bloc, /--profil/u, "le profil d'envoi n'est pas un choix");
});

test("la répétition à blanc ne référence ni secret ni environnement, et n'envoie pas", () => {
  const bloc = job("repetition");
  assert.ok(bloc, "le job repetition existe");
  assert.doesNotMatch(bloc, /secrets\./u);
  assert.doesNotMatch(bloc, /^ {4}environment:/mu);
  assert.match(bloc, /publier-envoi\.mjs --repetition/u);
  assert.equal((bloc.match(/--cible /gu) ?? []).length, 2);
  assert.doesNotMatch(bloc, /publier-envoi\.mjs --envoyer/u);
  assert.match(bloc, /^ {4}if: \$\{\{ !inputs\.envoyer \}\}$/mu);
});

test("les secrets ne sont lus que par l'env: de l'étape d'envoi de deployer", () => {
  const references = publication.match(/secrets\.[A-Z_]+/gu) ?? [];
  assert.deepEqual([...new Set(references)].sort(), [
    "secrets.CLOUDFLARE_ACCOUNT_ID",
    "secrets.CLOUDFLARE_API_TOKEN",
  ]);
  const deployer = job("deployer");
  for (const reference of references) assert.ok(deployer.includes(reference));
  // Jamais dans un `run:` ni imprimés.
  assert.doesNotMatch(publication, /echo[^\n]*(?:TOKEN|ACCOUNT_ID)/u);
});

test("wrangler n'est appelé que par l'outil épinglé, jamais directement par le workflow", () => {
  assert.doesNotMatch(publication.replace(/#.*$/gmu, ""), /wrangler/u);
});

test("la chaîne publie avec l'image, mesure les limites et prouve le démarrage sur l'arbre publié seul", () => {
  const bloc = job("publier");
  assert.match(bloc, /node tools\/publier\.mjs \\\n\s+--avec-image/u);
  assert.match(bloc, /--verifier "artifacts\/publication\/\$arbre" --profil "\$VAULT_PROFIL"/u);
  assert.match(bloc, /tests\/e2e\/publie-seul\.spec\.mjs/u);
  assert.match(bloc, /VAULT_ARBRE_PUBLIE: artifacts\/publication\/coquille/u);
  assert.match(bloc, /VAULT_E2E_EXIGER: "1"/u);
});
