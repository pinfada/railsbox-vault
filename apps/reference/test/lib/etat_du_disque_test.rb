require "test_helper"
require "tempfile"

# L'ÉTAT du système de fichiers applicatif, relevé par l'init du guest au montage (revue de la PR
# #211, constat 5). Sans lui, « le disque rouvert accepte l'écriture suivante » ne distinguait pas
# un disque sain d'un ext4 en erreur qui continue d'écrire.
class EtatDuDisqueTest < ActiveSupport::TestCase
  def releve(contenu)
    fichier = Tempfile.new("disque-de-donnees")
    fichier.write(contenu)
    fichier.close
    Vault::EtatDuDisque.lire(fichier.path)
  ensure
    fichier&.unlink
  end

  test "le relevé de l'init est lu clé par clé" do
    etat = releve("options=rw,relatime,errors=remount-ro,data=ordered\nerreurs=0\nalertes=0\nrejeu=1\n")

    assert_equal(
      {
        "options" => "rw,relatime,errors=remount-ro,data=ordered",
        "erreurs" => "0",
        "alertes" => "0",
        "rejeu" => "1"
      },
      etat
    )
  end

  test "une clé inconnue est ignorée, une clé absente reste absente" do
    etat = releve("erreurs=2\nchemin=/etc/passwd\n")

    assert_equal({ "erreurs" => "2" }, etat)
  end

  test "sans relevé (hors du guest), l'état est nil et non inventé" do
    assert_nil Vault::EtatDuDisque.lire(File.join(Dir.tmpdir, "aucun-releve-#{SecureRandom.hex(8)}"))
  end
end
