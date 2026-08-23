require "test_helper"

class ContractTest < ActiveSupport::TestCase
  test "le contrat expose l'identité figée de l'application" do
    assert_equal "railsbox-vault-reference", Vault::Contract.application_id
    assert_equal "1.0.0", Vault::Contract.application_version
  end

  test "l'identifiant de l'invariant est un UUID v4 en minuscules" do
    assert_match Record::UUID_V4, Vault::Contract.record.fetch("id")
  end

  test "la pièce jointe versionnée correspond exactement au contrat" do
    chemin = Vault::Contract.attachment_path
    assert chemin.exist?, "pièce jointe absente du dépôt : #{chemin}"

    contenu = chemin.binread
    assert_equal Vault::Contract.attachment.fetch("byteSize"), contenu.bytesize
    assert_equal Vault::Contract.attachment.fetch("sha256"), Digest::SHA256.hexdigest(contenu)
  end

  test "la pièce jointe est reproductible depuis la règle de dérivation publiée" do
    derivation = Vault::Contract.attachment.fetch("derivation")
    attendu = (0...derivation.fetch("blocks")).map do |index|
      Digest::SHA256.digest("railsbox-vault-reference/invariant/#{index}")
    end.join

    assert_equal derivation.fetch("blocks") * derivation.fetch("blockBytes"), attendu.bytesize
    assert_equal attendu, Vault::Contract.attachment_path.binread
  end

  test "une version de contrat inconnue est refusée, jamais ignorée" do
    Dir.mktmpdir do |repertoire|
      chemin = Pathname.new(repertoire).join("vault-invariant.json")
      chemin.write(JSON.generate({ "contractVersion" => 99 }))

      erreur = assert_raises(Vault::Contract::Error) { Vault::Contract.load_from(chemin) }
      assert_match(/version de contrat non gérée/, erreur.message)
    end
  end

  test "un contrat absent est signalé, jamais remplacé par un défaut" do
    Dir.mktmpdir do |repertoire|
      chemin = Pathname.new(repertoire).join("absent.json")

      erreur = assert_raises(Vault::Contract::Error) { Vault::Contract.load_from(chemin) }
      assert_match(/introuvable/, erreur.message)
    end
  end
end
