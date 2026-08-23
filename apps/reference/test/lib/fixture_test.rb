require "test_helper"

class FixtureTest < ActiveSupport::TestCase
  test "verify signale l'absence de l'invariant plutôt que de réussir à vide" do
    verification = Vault::Fixture.verify

    assert_equal Vault::Fixture::ABSENT, verification.status
    refute verification.conforming?
    assert_equal ["record.id"], verification.differences.map { |ecart| ecart["field"] }
  end

  test "create pose un invariant conforme" do
    resultat = Vault::Fixture.create

    assert resultat.fetch("created")
    assert resultat.fetch("attached")
    assert_equal Vault::Fixture::CONFORMING, Vault::Fixture.verify.status
  end

  test "create est idempotente : deux exécutions, un seul invariant" do
    premier = Vault::Fixture.create
    second = Vault::Fixture.create

    assert premier.fetch("created")
    refute second.fetch("created"), "le second appel a recréé l'enregistrement"
    refute second.fetch("attached"), "le second appel a rattaché une seconde pièce jointe"

    assert_equal 1, Record.count
    assert_equal 1, ActiveStorage::Attachment.count
    assert_equal 1, ActiveStorage::Blob.count
    assert_equal Vault::Fixture::CONFORMING, Vault::Fixture.verify.status
  end

  test "verify compare le contenu de la pièce jointe, pas seulement sa présence" do
    Vault::Fixture.create
    enregistrement = Record.find(Vault::Contract.record.fetch("id"))

    service = ActiveStorage::Blob.service
    chemin = service.path_for(enregistrement.evidence.key)
    File.binwrite(chemin, "contenu falsifié")

    verification = Vault::Fixture.verify

    assert_equal Vault::Fixture::DIVERGENT, verification.status
    champs = verification.differences.map { |ecart| ecart["field"] }
    assert_includes champs, "attachment.sha256"
    assert_includes champs, "attachment.byteSize"
  end

  test "verify diagnostique un fichier de pièce jointe disparu" do
    Vault::Fixture.create
    enregistrement = Record.find(Vault::Contract.record.fetch("id"))
    File.delete(ActiveStorage::Blob.service.path_for(enregistrement.evidence.key))

    verification = Vault::Fixture.verify

    assert_equal Vault::Fixture::DIVERGENT, verification.status
    assert_equal "fichier introuvable", verification.observed.dig("attachment", "state")
  end

  test "verify détecte une divergence de champ métier" do
    Vault::Fixture.create
    Record.find(Vault::Contract.record.fetch("id")).update_column(:label, "autre chose")

    verification = Vault::Fixture.verify

    assert_equal Vault::Fixture::DIVERGENT, verification.status
    ecart = verification.differences.find { |candidat| candidat["field"] == "record.label" }
    assert ecart, "aucun écart signalé sur record.label"
    assert_equal "autre chose", ecart["actual"]
    assert_equal Vault::Contract.record.fetch("label"), ecart["expected"]
  end

  test "le rapport de divergence nomme chaque champ en écart" do
    Vault::Fixture.create
    Record.find(Vault::Contract.record.fetch("id")).update_column(:sequence, 42)

    rapport = Vault::Fixture.verify.report

    assert_match(/invariant divergent/, rapport)
    assert_match(/record\.sequence/, rapport)
    assert_match(/42/, rapport)
  end
end
