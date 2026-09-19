# Version 1.1.0 de l'application de référence (#236 T2, ADR 0042) : le SECOND paquet, celui qui
# éprouve la mise à jour d'un coffre sans perte. Une colonne ajoutée, facultative : les notes écrites
# sous 1.0.0 la relisent vide, et rien de ce qu'elles portaient ne bouge.
class AddCommentaireToRecords < ActiveRecord::Migration[8.1]
  def change
    add_column :records, :commentaire, :string, limit: 200
  end
end
