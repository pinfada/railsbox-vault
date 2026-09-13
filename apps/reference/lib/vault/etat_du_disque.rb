module Vault
  # L'ÉTAT du système de fichiers applicatif, tel que l'init du guest l'a relevé
  # au montage (`guest-init.sh`, revue de la PR #211, constat 5) : options
  # montées, compteur d'erreurs du superbloc, alertes du noyau, rejeu du journal.
  #
  # L'application ne mesure rien elle-même : elle PUBLIE ce relevé, pour qu'un
  # scénario de bout en bout puisse exiger un disque sans erreur à chaque boot à
  # froid sans rien ajouter au pont série. Hors du guest il n'existe pas, et
  # l'état rendu est `nil` — jamais un « 0 » inventé.
  module EtatDuDisque
    CHEMIN = "/run/vault-disque-applicatif".freeze
    CLES = %w[options erreurs alertes rejeu].freeze

    module_function

    def lire(chemin = ENV.fetch("VAULT_ETAT_DU_DISQUE", CHEMIN))
      return nil unless File.file?(chemin)

      File.readlines(chemin, chomp: true).each_with_object({}) do |ligne, etat|
        cle, valeur = ligne.split("=", 2)
        etat[cle] = valeur.to_s if CLES.include?(cle)
      end
    end
  end
end
