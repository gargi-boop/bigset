import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDatasetRecipe,
  PlaywrightRecipeRunner,
} from "../src/dataset-agent/index.js";
import type {
  DatasetAgentRunInput,
  DatasetRecipePageLike,
} from "../src/dataset-agent/index.js";

const runInput: DatasetAgentRunInput = {
  prompt: "Find latest blog posts from OpenAI with title and source URL.",
  promptId: "playwright-recipe-fixture",
  promptQuality: "good",
  requiredColumns: ["entity_name", "latest_post_title", "source_url"],
};

test("Playwright recipe runner executes a generated recipe against a page context", async () => {
  const page = new StaticFixturePage();
  const recipe = createDatasetRecipe({
    recipeId: "playwright-recipe-success",
    datasetId: "dataset-ai-posts",
    version: 1,
    scriptText: `
      export async function runDatasetRecipe({ page, emitRow, log }) {
        log("opening fixture page");
        await page.goto("https://fixture.local/news");
        const entityName = await page.textContent("h1");
        const latestPostTitle = await page.textContent("article h2");
        const sourceUrl = page.url();

        emitRow({
          cells: {
            entity_name: entityName,
            latest_post_title: latestPostTitle,
            source_url: sourceUrl
          },
          sourceUrls: [sourceUrl],
          evidence: [{
            columnName: "latest_post_title",
            sourceUrl,
            quote: latestPostTitle
          }],
          needsReview: false
        });
      }
    `,
    requestedColumns: runInput.requiredColumns,
    sourcePrompt: runInput.prompt,
  });
  const runner = new PlaywrightRecipeRunner({
    browserFactory: async () => ({
      page,
      close: async () => {
        page.wasClosed = true;
      },
    }),
    timeoutMs: 1_000,
  });

  const result = await runner.runRecipe({ recipe, runInput });

  assert.equal(result.runStatus, "succeeded");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.cells.entity_name, "OpenAI");
  assert.equal(result.productionValidation.isValid, true);
  assert.equal(result.productionValidation.requestedCellCompletenessRatio, 1);
  assert.equal(result.metrics.browserCalls, 1);
  assert.equal(page.wasClosed, true);
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.kind),
    ["stdout", "url-history", "dom", "screenshot"]
  );
});

test("Playwright recipe runner captures timeout failures as failed runs", async () => {
  const page = new StaticFixturePage();
  const recipe = createDatasetRecipe({
    recipeId: "playwright-recipe-timeout",
    datasetId: "dataset-ai-posts",
    version: 1,
    scriptText: `
      export async function runDatasetRecipe() {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    `,
    requestedColumns: runInput.requiredColumns,
    sourcePrompt: runInput.prompt,
  });
  const runner = new PlaywrightRecipeRunner({
    browserFactory: async () => ({
      page,
      close: async () => {
        page.wasClosed = true;
      },
    }),
    timeoutMs: 5,
  });

  const result = await runner.runRecipe({ recipe, runInput });

  assert.equal(result.runStatus, "failed");
  assert.equal(result.productionValidation.isValid, false);
  assert.match(result.validationIssues.join("\n"), /timed out/i);
  assert.equal(page.wasClosed, true);
  assert.ok(result.artifacts.some((artifact) => artifact.kind === "stderr"));
});

class StaticFixturePage implements DatasetRecipePageLike {
  wasClosed = false;
  private currentUrl = "";

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async textContent(selector: string): Promise<string> {
    if (selector === "h1") {
      return "OpenAI";
    }
    if (selector === "article h2") {
      return "Release notes";
    }
    return "";
  }

  url(): string {
    return this.currentUrl;
  }

  async content(): Promise<string> {
    return "<html><body><h1>OpenAI</h1><article><h2>Release notes</h2></article></body></html>";
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([1, 2, 3]);
  }
}
