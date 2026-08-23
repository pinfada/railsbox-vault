require "test_helper"

class RecordTest < ActiveSupport::TestCase
  test "un identifiant qui n'est pas un UUID v4 est refusé" do
    %w[
      pas-un-uuid
      F2B2A4E0-6A5F-4A3C-9C1A-1D0A5B8E7C31
      f2b2a4e0-6a5f-1a3c-9c1a-1d0a5b8e7c31
      f2b2a4e0-6a5f-4a3c-cc1a-1d0a5b8e7c31
    ].each do |candidat|
      enregistrement = construire(id: candidat)
      refute enregistrement.valid?, "#{candidat} aurait dû être refusé"
      assert_includes enregistrement.errors[:id], "n'est pas un UUID v4 en minuscules"
    end
  end

  test "l'identifiant du contrat est accepté" do
    assert construire.valid?, construire.errors.full_messages.to_sentence
  end

  test "l'identifiant est immuable après création" do
    enregistrement = construire
    enregistrement.save!

    enregistrement.id = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f"

    refute enregistrement.valid?(:update)
    assert_match(/est immuable/, enregistrement.errors[:id].first)
  end

  test "les champs de l'invariant sont obligatoires" do
    enregistrement = Record.new(id: Vault::Contract.record.fetch("id"))

    refute enregistrement.valid?
    %i[label payload sequence recorded_at].each do |champ|
      refute_empty enregistrement.errors[champ], "#{champ} devrait être exigé"
    end
  end

  test "une séquence nulle ou négative est refusée" do
    refute construire(sequence: 0).valid?
    refute construire(sequence: -1).valid?
  end

  private

  def construire(attributs = {})
    attendu = Vault::Contract.record
    Record.new({
      id: attendu.fetch("id"),
      label: attendu.fetch("label"),
      payload: attendu.fetch("payload"),
      sequence: attendu.fetch("sequence"),
      recorded_at: Time.iso8601(attendu.fetch("recordedAt"))
    }.merge(attributs))
  end
end
