import { argv } from "node:process";

import {
  generateSyntheticCorpus,
  parseCorpusArgs
} from "../packages/sitemap/src/testing/synthetic-corpus.js";

/**
 * CLI over the synthetic corpus generator.
 *
 * The generator lives in packages/sitemap because the scale benchmark imports
 * it and a test cannot reach outside its own compilation root.
 *
 *   pnpm gen:sitemaps --out .tmp/sitemaps --urls 10000000
 */
const options = parseCorpusArgs(argv.slice(2));
const started = Date.now();
const result = generateSyntheticCorpus(options);

console.log(
  `generated ${result.urls.toLocaleString()} URLs across ${result.files} files ` +
    `in ${options.outDir} (seed ${options.seed}, ${Date.now() - started}ms)`
);
