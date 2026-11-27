/**
 * Les secrets lus dans le CONTENU des fichiers qui entrent dans un paquet (#342).
 *
 * Provenance : les deux signaux et leurs cas sont repris de `pinfada/railsbox`,
 * `tests/env-secrets.test.mjs` (même propriétaire, licence MIT des deux côtés) :
 *   · le NOM de la clé annonce un secret (`…SECRET…`, `…TOKEN…`, `…PASSWORD…`) ;
 *   · la VALEUR a la forme d'un jeton émis par un service connu, quel que soit le nom.
 * RailsBox les applique au bloc `env:` de `railsbox.yml` ; le coffre les applique aux lignes des
 * fichiers de la source, car le paquet est servi publiquement et se monte hors ligne.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  INDICES_DE_NOM_SECRET,
  indiceDeNomSecret,
  ressembleAUnJeton,
  secretsDuContenu,
} from "../../tools/paquet/secrets-du-contenu.mjs";

const codes = (chemin, contenu, assumesPublics = []) =>
  secretsDuContenu({ chemin, contenu, assumesPublics }).map(({ code }) => code);

test("un nom de clé qui annonce un secret est reconnu, sans égard à la casse", () => {
  for (const nom of [
    "RAILS_MASTER_KEY",
    "secret_key_base",
    "password",
    "github_token",
    "SENDGRID_API_KEY",
    "ssh_private_key",
    "google_credentials",
    "aws_access_key_id",
    "MEDICAL_DATA_ENCRYPTION_KEY",
    "jwt_signing_key",
  ]) {
    assert.notEqual(indiceDeNomSecret(nom), null, `${nom} devrait être reconnu`);
  }
  for (const nom of ["adapter", "database", "host", "public_key", "keyboard", "pool"]) {
    assert.equal(indiceDeNomSecret(nom), null, `${nom} ne devrait pas être reconnu`);
  }
  assert.ok(INDICES_DE_NOM_SECRET.includes("PASSWORD"));
});

test("une valeur à préfixe de jeton connu est reconnue", () => {
  for (const valeur of [
    "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "sk_live_0123456789abcdefghij",
    "sk-proj-0123456789abcdefghijklmnopqrstuvwxyz",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-fixture-fixture-fixture",
    "glpat-0123456789abcdefghij",
    "AIzaSyA0123456789abcdefghijklmnopqrstuvw",
    "-----BEGIN RSA PRIVATE KEY-----",
  ]) {
    assert.equal(ressembleAUnJeton(valeur), true, `${valeur} devrait être reconnu`);
  }
  for (const valeur of ["http://localhost:8080", "production", "", "skateboard"]) {
    assert.equal(ressembleAUnJeton(valeur), false, `${valeur} ne devrait pas être reconnu`);
  }
});

test("un mot de passe en clair dans config/database.yml est un secret", () => {
  const contenu = "production:\n  adapter: postgresql\n  password: s3cr3t-de-prod\n";
  assert.deepEqual(codes("config/database.yml", contenu), ["secret-dans-le-contenu"]);
});

test("une référence à l'environnement n'est PAS un secret : la valeur n'est pas dans le fichier", () => {
  const contenu =
    "production:\n" +
    '  password: <%= ENV["DATABASE_PASSWORD"] %>\n' +
    "  username: <%= ENV.fetch('DB_USER') %>\n" +
    "  secret_key_base:\n" +
    "  token: ~\n" +
    '  api_key: ""\n';
  assert.deepEqual(codes("config/database.yml", contenu), []);
});

test("un jeton dans db/seeds.rb est un secret, quel que soit son nom", () => {
  const contenu =
    'Integration.create!(nom: "forge", jeton: "ghp_0123456789abcdefghijklmnopqrstuvwxyz")\n';
  assert.deepEqual(codes("db/seeds.rb", contenu), ["secret-dans-le-contenu"]);
});

test("un jeton est refusé PARTOUT, même hors de config/ et de db/", () => {
  const contenu = 'STRIPE = "sk_live_0123456789abcdefghij"\n';
  assert.deepEqual(codes("app/services/paiement.rb", contenu), ["secret-dans-le-contenu"]);
});

test("une clé privée PEM collée dans un fichier est un secret", () => {
  const contenu = "CLE = <<~PEM\n  -----BEGIN OPENSSH PRIVATE KEY-----\n  b3BlbnNzaA==\nPEM\n";
  assert.deepEqual(codes("lib/signature.rb", contenu), ["secret-dans-le-contenu"]);
});

test("le nom seul ne refuse que sous config/ et dans les graines : le code applicatif reste lisible", () => {
  // Un modèle qui manipule un mot de passe n'en contient pas : un refus qui crie partout n'est plus lu.
  const modele =
    "class User < ApplicationRecord\n" +
    "  has_secure_password\n" +
    '  validates :password, length: { minimum: 8 }, if: -> { password != "" }\n' +
    "end\n";
  assert.deepEqual(codes("app/models/user.rb", modele), []);
  const test_ = 'user = User.new(password: "motdepasse-de-test")\n';
  assert.deepEqual(codes("test/models/user_test.rb", test_), []);
});

test("le diagnostic nomme le fichier, la ligne et la clé, sans jamais citer la valeur", () => {
  const [constat] = secretsDuContenu({
    chemin: "config/database.yml",
    contenu: "production:\n  password: s3cr3t-de-prod\n",
  });
  assert.equal(constat.fichier, "config/database.yml");
  assert.equal(constat.ligne, 2);
  assert.equal(constat.cle, "password");
  assert.equal(JSON.stringify(constat).includes("s3cr3t-de-prod"), false);
});

test("une valeur DÉCLARÉE publique passe, et elle seule", () => {
  const contenu =
    'User.create!(email: "demo@example.com", password: "demo1234")\n' +
    'Service.create!(api_key: "vraie-cle-de-service")\n';
  assert.deepEqual(codes("db/seeds.rb", contenu), [
    "secret-dans-le-contenu",
    "secret-dans-le-contenu",
  ]);
  assert.deepEqual(codes("db/seeds.rb", contenu, [{ fichier: "db/seeds.rb", cle: "password" }]), [
    "secret-dans-le-contenu",
  ]);
});

test("la dérogation ne peut être ni globale ni déplacée vers un autre fichier", () => {
  const contenu = '  password: "demo1234"\n';
  for (const derogation of [
    [{ fichier: "*", cle: "password" }],
    [{ fichier: "db/seeds.rb", cle: "*" }],
    [{ fichier: "config/autre.yml", cle: "password" }],
    [{ cle: "password" }],
    ["password"],
  ]) {
    assert.deepEqual(
      codes("db/seeds.rb", contenu, derogation),
      ["secret-dans-le-contenu"],
      `${JSON.stringify(derogation)} ne doit rien couvrir`,
    );
  }
});

test("un jeton n'est jamais couvert par une dérogation de nom", () => {
  const contenu = 'Service.create!(password: "ghp_0123456789abcdefghijklmnopqrstuvwxyz")\n';
  assert.deepEqual(codes("db/seeds.rb", contenu, [{ fichier: "db/seeds.rb", cle: "password" }]), [
    "secret-dans-le-contenu",
  ]);
});
