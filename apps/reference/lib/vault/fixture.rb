require "digest"
require "time"

module Vault
  # Création et vérification de l'invariant durable.
  #
  # L'invariant est un unique enregistrement d'identifiant figé, porteur d'une
  # pièce jointe dont le contenu est versionné et l'empreinte connue. Il est
  # conçu pour répondre à une seule question après un boot à froid : « ce que le
  # coffre a rendu est-il exactement ce qui y a été écrit ? »
  module Fixture
    # Verdict de vérification. `status` prend trois valeurs et trois seulement ;
    # aucune autre issue n'est possible, en particulier pas un succès par défaut.
    Verification = Struct.new(:status, :differences, :observed, keyword_init: true) do
      def conforming? = status == CONFORMING

      def as_json(*)
        {
          "status" => status,
          "expected" => Fixture.expected,
          "observed" => observed,
          "differences" => differences
        }
      end

      # Diagnostic lisible, destiné à la sortie d'erreur de `bin/vault-fixture`.
      def report
        return "invariant conforme (#{Contract.record.fetch("id")})" if conforming?

        lignes = ["invariant #{status} (#{Contract.record.fetch("id")})"]
        differences.each do |ecart|
          lignes << "  · #{ecart["field"]} : attendu #{ecart["expected"].inspect}, obtenu #{ecart["actual"].inspect}"
        end
        lignes.join("\n")
      end
    end

    CONFORMING = "conforming".freeze
    DIVERGENT = "divergent".freeze
    ABSENT = "absent".freeze

    module_function

    # Crée l'invariant s'il manque, le retrouve sinon. Deux exécutions
    # successives produisent le même état et le même code de sortie.
    #
    # @return [Hash] { "created" => Boolean, "attached" => Boolean }
    def create
      attendu = Contract.record
      enregistrement = ::Record.find_or_initialize_by(id: attendu.fetch("id"))
      cree = enregistrement.new_record?

      enregistrement.assign_attributes(
        label: attendu.fetch("label"),
        payload: attendu.fetch("payload"),
        sequence: attendu.fetch("sequence"),
        recorded_at: Time.iso8601(attendu.fetch("recordedAt"))
      )
      enregistrement.save!

      attachee = false
      unless enregistrement.evidence.attached?
        Contract.attachment_path.open("rb") do |flux|
          enregistrement.evidence.attach(
            io: flux,
            filename: Contract.attachment.fetch("filename"),
            content_type: Contract.attachment.fetch("contentType"),
            identify: false
          )
        end
        attachee = true
      end

      { "created" => cree, "attached" => attachee }
    end

    # Compare l'état persisté au contrat, champ par champ. Ne lève jamais pour
    # une divergence : une divergence est un résultat, pas un incident.
    def verify
      attendu = Contract.record
      enregistrement = ::Record.find_by(id: attendu.fetch("id"))
      return Verification.new(status: ABSENT, differences: [absence_ecart], observed: nil) if enregistrement.nil?

      constate = observe(enregistrement)
      ecarts = comparer(expected, constate)
      Verification.new(
        status: ecarts.empty? ? CONFORMING : DIVERGENT,
        differences: ecarts,
        observed: constate
      )
    end

    # Forme canonique de ce qui est attendu. Sert au verdict comme à la réponse
    # HTTP : le client voit ce à quoi on l'a comparé.
    def expected
      attendu = Contract.record
      piece = Contract.attachment
      {
        "record" => {
          "id" => attendu.fetch("id"),
          "label" => attendu.fetch("label"),
          "payload" => attendu.fetch("payload"),
          "sequence" => attendu.fetch("sequence"),
          "recordedAt" => attendu.fetch("recordedAt")
        },
        "attachment" => {
          "filename" => piece.fetch("filename"),
          "contentType" => piece.fetch("contentType"),
          "byteSize" => piece.fetch("byteSize"),
          "sha256" => piece.fetch("sha256")
        }
      }
    end

    def observe(enregistrement)
      {
        "record" => {
          "id" => enregistrement.id,
          "label" => enregistrement.label,
          "payload" => enregistrement.payload,
          "sequence" => enregistrement.sequence,
          "recordedAt" => enregistrement.recorded_at&.utc&.iso8601
        },
        "attachment" => observe_attachment(enregistrement)
      }
    end

    def observe_attachment(enregistrement)
      return { "state" => "absente" } unless enregistrement.evidence.attached?

      piece = enregistrement.evidence
      contenu = piece.download
      {
        "filename" => piece.filename.to_s,
        "contentType" => piece.content_type,
        "byteSize" => contenu.bytesize,
        "sha256" => Digest::SHA256.hexdigest(contenu)
      }
    rescue ActiveStorage::FileNotFoundError => erreur
      # L'enregistrement a survécu mais son fichier a disparu du volume : c'est
      # exactement le mode de panne que l'invariant doit rendre visible.
      { "state" => "fichier introuvable", "detail" => erreur.class.name }
    end

    def comparer(attendu, observe)
      ecarts = []
      attendu.each do |section, champs|
        champs.each do |champ, valeur|
          obtenu = observe.dig(section, champ)
          next if obtenu == valeur

          ecarts << { "field" => "#{section}.#{champ}", "expected" => valeur, "actual" => obtenu }
        end
      end
      ecarts
    end

    def absence_ecart
      {
        "field" => "record.id",
        "expected" => Contract.record.fetch("id"),
        "actual" => nil
      }
    end
  end
end
