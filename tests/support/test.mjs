import { expect, test as base } from "@playwright/test";

import { instrumenterNavigationFirefox } from "./navigation-firefox.mjs";

/**
 * Fixture automatique commune aux trois suites du gate. Elle branche le correctif avant la page
 * standard et sur toute page créée ensuite avec `context.newPage()`.
 */
export const test = base.extend({
  _navigationFirefox: [
    async ({ context, browserName }, use, testInfo) => {
      const brancher = (page) =>
        instrumenterNavigationFirefox(page, {
          browserName,
          baseURL: testInfo.project.use.baseURL,
          annoter: (annotation) => testInfo.annotations.push(annotation),
        });

      context.on("page", brancher);
      for (const page of context.pages()) brancher(page);
      await use();
      context.off("page", brancher);
    },
    { auto: true },
  ],
});

export { expect };
