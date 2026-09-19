# La DEUXIÈME migration de la version 1.1.0 (#236 T2, ADR 0042) : un index sur la séquence. Elle
# existe pour que la mise à jour en joue DEUX — Rails commite migration par migration, et une coupure
# entre les deux laisse un schéma INTERMÉDIAIRE que l'épreuve de coupure doit savoir reprendre.
class IndexRecordsOnSequence < ActiveRecord::Migration[8.1]
  def change
    add_index :records, :sequence
  end
end
