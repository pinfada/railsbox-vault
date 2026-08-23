# Porteur de l'invariant durable.
#
# La clé primaire est l'UUID v4 lui-même, pas un entier auto-incrémenté doublé
# d'une colonne « uuid » : l'identifiant immuable de l'invariant doit être celui
# par lequel on le retrouve, sinon deux identités coexistent et l'une des deux
# finit par diverger.
class Record < ApplicationRecord
  # UUID v4 en minuscules : quatrième groupe commençant par « 4 », cinquième par
  # 8, 9, a ou b. Un UUID d'une autre version passerait pour un identifiant
  # valide alors que le contrat en promet un v4.
  #
  # Les classes de caractères sont écrites en toutes lettres plutôt qu'avec
  # `\h`, qui accepte aussi les majuscules : deux écritures d'un même UUID
  # seraient alors deux identifiants distincts pour SQLite et une seule identité
  # pour le lecteur humain.
  UUID_V4 = /\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/.freeze

  has_one_attached :evidence

  validates :id, presence: true, format: { with: UUID_V4, message: "n'est pas un UUID v4 en minuscules" }
  validates :label, presence: true
  validates :payload, presence: true
  validates :sequence, numericality: { only_integer: true, greater_than: 0 }
  validates :recorded_at, presence: true

  validate :identifiant_immuable, on: :update

  private

  def identifiant_immuable
    return unless id_changed?

    errors.add(:id, "est immuable : #{id_was.inspect} ne peut pas devenir #{id.inspect}")
  end
end
