// Driver for the make.fun "Make Markdown rendering faster" bounty.
// Reads every case from /input/cases.json (or MAKEFUN_INPUT_DIR), renders each
// one alone with parse() from ./parse.js, and writes /output/html.json
// (or MAKEFUN_OUTPUT_DIR): a JSON array of the HTML strings, one per case,
// in the cases' order. Runs as `node /bot/main.ts` on Node 22, which strips
// TypeScript types natively, so this file uses erasable syntax only.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = new Array(cases.length);
// Each case is rendered alone: parse() holds no cross-case state, so the
// output is deterministic and independent of case order.
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i]!.markdown);
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
