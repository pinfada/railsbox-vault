// SQUELETTE NAÏF (#299) : désinscrit tout, vide tout.
export async function retirerLaCopie({ conteneur, caches }) {
  for (const inscription of await conteneur.getRegistrations()) await inscription.unregister();
  for (const nom of await caches.keys()) await caches.delete(nom);
  return { desinscrite: true, caches: [] };
}
