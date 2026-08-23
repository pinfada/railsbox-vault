require "json"

module Vault
  # Lecture du contrat d'invariant, source unique partagée par l'application
  # Rails, la commande de fixture, le manifeste d'image et les tests Node du
  # dépôt. Rien de ce que décrit ce contrat n'est recopié ailleurs en Ruby : un
  # écart entre le JSON et le code doit être impossible, pas seulement improbable.
  module Contract
    Error = Class.new(StandardError)

    SUPPORTED_VERSION = 1

    class << self
      def path
        Rails.root.join("vault-invariant.json")
      end

      def attachment_path
        Rails.root.join("invariant", data.fetch("attachment").fetch("filename"))
      end

      def data
        @data ||= load_from(path)
      end

      # Lecture explicite d'un contrat donné. Publique afin que les tests
      # puissent exercer le refus d'une version inconnue sans simulacre : c'est
      # le vrai code de chargement qui est mis à l'épreuve.
      def load_from(chemin)
        raise Error, "contrat d'invariant introuvable : #{chemin}" unless chemin.exist?

        parsed = JSON.parse(chemin.read)
        version = parsed["contractVersion"]
        unless version == SUPPORTED_VERSION
          raise Error, "version de contrat non gérée : #{version.inspect} (attendu #{SUPPORTED_VERSION})"
        end

        parsed.freeze
      end

      def application_id = data.fetch("application").fetch("id")
      def application_version = data.fetch("application").fetch("version")
      def record = data.fetch("record")
      def attachment = data.fetch("attachment")

      # Ne sert qu'aux tests : recharge le contrat depuis le disque.
      def reset!
        @data = nil
      end
    end
  end
end
