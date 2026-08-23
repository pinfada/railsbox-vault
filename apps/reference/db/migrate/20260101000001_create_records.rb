class CreateRecords < ActiveRecord::Migration[8.1]
  def change
    # Clé primaire textuelle : l'UUID v4 de l'invariant. `limit: 36` refuse au
    # niveau du schéma ce que la validation du modèle refuse au niveau Ruby.
    create_table :records, id: :string, limit: 36 do |t|
      t.string :label, null: false
      t.text :payload, null: false
      t.integer :sequence, null: false
      t.datetime :recorded_at, null: false

      t.timestamps
    end
  end
end
