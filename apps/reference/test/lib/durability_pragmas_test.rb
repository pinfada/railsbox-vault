require "test_helper"

# L'invariant sert à prouver la persistance après coupure. Deux réglages SQLite
# décident si une écriture acquittée l'est vraiment ; ils sont écrits dans
# `config/database.yml` et vérifiés ici SUR LA CONNEXION, parce qu'une ligne de
# configuration non appliquée est indiscernable d'une ligne absente.
class DurabilityPragmasTest < ActiveSupport::TestCase
  test "le journal SQLite est un journal d'annulation, pas un WAL" do
    assert_equal "delete", pragma("journal_mode").downcase
  end

  test "synchronous vaut EXTRA : le répertoire est synchronisé après l'effacement du journal" do
    # PRAGMA synchronous rend un entier : 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA.
    #
    # FULL (2) ne suffit pas en `journal_mode = delete` : le commit est l'effacement du `-journal`,
    # et FULL ne synchronise pas le répertoire après cet effacement. Une coupure juste après
    # l'acquittement laisse un journal « chaud » que SQLite rejoue au boot suivant — la transaction
    # acquittée est annulée (#209 : 4/4 perdues à 0 s sous v86 ; 0/3 relues sur ext2 en boucle, 3/3
    # avec EXTRA).
    assert_equal 3, pragma("synchronous").to_i
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
