require "test_helper"

# L'invariant sert à prouver la persistance après coupure. Deux réglages SQLite
# décident si une écriture acquittée l'est vraiment ; ils sont écrits dans
# `config/database.yml` et vérifiés ici SUR LA CONNEXION, parce qu'une ligne de
# configuration non appliquée est indiscernable d'une ligne absente.
class DurabilityPragmasTest < ActiveSupport::TestCase
  test "le journal SQLite est un journal d'annulation, pas un WAL" do
    assert_equal "delete", pragma("journal_mode").downcase
  end

  test "synchronous vaut FULL : fsync avant acquittement du commit" do
    # PRAGMA synchronous rend un entier : 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA.
    assert_equal 2, pragma("synchronous").to_i
  end

  test "les clés étrangères sont vérifiées par le moteur" do
    assert_equal 1, pragma("foreign_keys").to_i
  end

  private

  def pragma(nom)
    ActiveRecord::Base.with_connection do |connexion|
      connexion.select_value("PRAGMA #{nom}")
    end
  end
end
