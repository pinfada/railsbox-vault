// Un CRAN de résolution pour Node : les modules de `public/` importent `/src/…` et `/public/…` en
// chemins absolus (ce que le navigateur sert). Ce cran les rend à la racine du dépôt, pour que les
// épreuves importent les VRAIS modules de la page — et que la campagne de mutation les rejoue.

export async function resolve(specifier, context, suite) {
  if (specifier.startsWith("/src/") || specifier.startsWith("/public/")) {
    return suite(new URL(`../..${specifier}`, import.meta.url).href, context);
  }
  return suite(specifier, context);
}
