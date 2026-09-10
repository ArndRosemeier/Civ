#!/usr/bin/env node
/**
 * CivTS headless CLI. See PLAN.md 8.1.
 *
 * This is the agent's primary interface to the game: text in, text out, no
 * browser and no eyes required. Subcommands land as milestones land — M0 ships
 * `provenance`, M2 ships `play` (the REPL).
 */

import { CATALOG, summarizeProvenance, validateRuleset, type RulesetError } from '@civts/rules';

const USAGE = `civts — headless tooling

Usage: civts <command> [options]

Commands:
  provenance   print the rules-data provenance table (cited vs placeholder)
  play         interactive text REPL                      (arrives in M2)
  run          headless AI-vs-AI game                     (arrives in M7)

Options:
  -h, --help   show this help
`;

const formatError = (e: RulesetError): string => {
  switch (e.kind) {
    case 'empty-catalog':
      return `empty catalog: ${e.catalog}`;
    case 'duplicate-id':
      return `duplicate id in ${e.catalog}: ${e.id}`;
    case 'placeholder-in-cited-only':
      return `placeholder row in cited-only mode: ${e.catalog}/${e.id} (${e.note})`;
    case 'invalid-value':
      return `invalid value: ${e.catalog}/${e.id}.${e.field} — ${e.detail}`;
  }
};

const commandProvenance = (): number => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    for (const e of validated.error) console.error(`ruleset error: ${formatError(e)}`);
    return 1;
  }

  const summary = summarizeProvenance(CATALOG);
  const pct = summary.total === 0 ? 0 : Math.round((summary.cited / summary.total) * 100);
  console.log(`ruleset provenance — ${String(summary.cited)}/${String(summary.total)} cited (${String(pct)}%), ${String(summary.placeholder)} placeholder`);
  console.log('');

  const width = Math.max(...CATALOG.terrains.map((t) => t.id.length));
  for (const t of CATALOG.terrains) {
    const p = t.provenance;
    const detail = p.kind === 'cited' ? p.source : p.note;
    console.log(`  ${t.id.padEnd(width)}  ${p.kind.padEnd(11)}  ${detail}`);
  }

  console.log('');
  console.log('cited-only mode is expected to FAIL until rows are traced to sources.');
  return 0;
};

const main = (argv: readonly string[]): number => {
  const [command] = argv;

  if (command === undefined || command === '-h' || command === '--help') {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case 'provenance':
      return commandProvenance();
    case 'play':
      console.log('play: the interactive text REPL arrives in M2.');
      return 0;
    case 'run':
      console.log('run: the headless self-play harness arrives in M7.');
      return 0;
    default:
      console.error(`unknown command: ${command}`);
      console.error(USAGE);
      return 2;
  }
};

process.exit(main(process.argv.slice(2)));
