
/**
 * Scratchfuscator CLI
 *
 * Usage:
 *   scratchfuscator input.sb3 -o output.sb3 --preset heavy
 *   scratchfuscator input.sb3                              # outputs input.obfuscated.sb3
 *   scratchfuscator input.sb3 --preset max --no-cff        # max preset but CFF disabled
 *   scratchfuscator input.sb3 --config config.json         # custom config file
 */

import * as fs from 'fs';
import * as path from 'path';
import { readSB3, writeSB3 } from './sb3';
import { obfuscate } from './transforms';
import { ObfuscatorConfig, PRESETS, PRESET_MEDIUM, mergeConfig } from './config';

interface CLIArgs {
  input: string;
  output: string;
  preset: string;
  configFile: string | null;
  overrides: Partial<any>;
}

function parseArgs(argv: string[]): CLIArgs {
  const args = argv.slice(2);
  let input = '';
  let output = '';
  let preset = 'medium';
  let configFile: string | null = null;
  const overrides: any = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-o' || arg === '--output') {
      output = args[++i] || '';
    } else if (arg === '-p' || arg === '--preset') {
      preset = args[++i] || 'medium';
    } else if (arg === '-c' || arg === '--config') {
      configFile = args[++i] || null;
    } else if (arg === '--no-cff') {
      overrides.cff = { enabled: false };
    } else if (arg === '--no-deadcode') {
      overrides.deadCode = { enabled: false };
    } else if (arg === '--no-constants') {
      overrides.constants = { enabled: false };
    } else if (arg === '--no-renaming') {
      overrides.renaming = { enabled: false };
    } else if (arg === '--no-fakedata') {
      overrides.fakeData = { enabled: false };
    } else if (arg === '--no-scramble') {
      overrides.scramble = { enabled: false };
    } else if (arg === '--linear-dispatch') {
      overrides.cff = { ...(overrides.cff || {}), bstDispatch: false };
    } else if (arg === '--dead-states') {
      const n = parseInt(args[++i], 10);
      overrides.cff = { ...(overrides.cff || {}), deadStatesPerScript: n };
    } else if (arg === '--exclude-vars') {
      const vars = (args[++i] || '').split(',').map(s => s.trim());
      overrides.renaming = { ...(overrides.renaming || {}), excludeVariables: vars };
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg === '--list-presets') {
      console.log('Available presets: ' + Object.keys(PRESETS).join(', '));
      process.exit(0);
    } else if (!arg.startsWith('-') && !input) {
      input = arg;
    }
  }

  if (!input) {
    console.error('Error: No input file specified.');
    printHelp();
    process.exit(1);
  }

  if (!output) {
    const ext = path.extname(input);
    const base = path.basename(input, ext);
    const dir = path.dirname(input);
    output = path.join(dir, `${base}.obfuscated${ext}`);
  }

  return { input, output, preset, configFile, overrides };
}

function printHelp(): void {
  console.log(`
Scratchfuscator - SB3 project obfuscator with CFF, dead code, and more

Usage:
  scratchfuscator <input.sb3> [options]

Options:
  -o, --output <file>     Output file path (default: input.obfuscated.sb3)
  -p, --preset <name>     Preset: light, medium, heavy, max (default: medium)
  -c, --config <file>     Path to a JSON config file (overrides preset)
  --no-cff                Disable control flow flattening
  --no-deadcode           Disable dead code injection
  --no-constants          Disable constant obfuscation
  --no-renaming           Disable renaming
  --no-fakedata           Disable fake data generation
  --no-scramble           Disable visual scrambling
  --linear-dispatch       Use linear if-chain dispatch instead of BST
  --dead-states <n>       Number of dead CFF states per script
  --exclude-vars <a,b,c>  Variable names to exclude from renaming
  --list-presets          List available presets
  -h, --help              Show this help

Examples:
  scratchfuscator game.sb3 -o game_obf.sb3 --preset heavy
  scratchfuscator game.sb3 --preset max --dead-states 20
  scratchfuscator game.sb3 --no-cff --no-scramble
  scratchfuscator game.sb3 --exclude-vars "Score,Lives,Health"
  `);
}

async function main(): Promise<void> {
  const { input, output, preset, configFile, overrides } = parseArgs(process.argv);

  // Resolve config
  let baseConfig: ObfuscatorConfig = PRESETS[preset] || PRESET_MEDIUM;

  if (configFile) {
    try {
      const customConfig = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      baseConfig = mergeConfig(baseConfig, customConfig);
    } catch (e: any) {
      console.error(`Error reading config file: ${e.message}`);
      process.exit(1);
    }
  }

  const config = mergeConfig(baseConfig, overrides);

  // Check input file exists
  if (!fs.existsSync(input)) {
    console.error(`Error: Input file not found: ${input}`);
    process.exit(1);
  }

  console.log(`Input:  ${input}`);
  console.log(`Output: ${output}`);
  console.log(`Preset: ${preset}`);
  console.log('');

  const startTime = Date.now();

  try {
    const { project, zip } = await readSB3(input);

    console.log(`Loaded project with ${project.targets.length} targets`);
    let totalBlocks = 0;
    for (const t of project.targets) {
      totalBlocks += Object.keys(t.blocks).length;
    }
    console.log(`Total blocks: ${totalBlocks}`);
    console.log('');

    const obfuscated = obfuscate(project, config);

    let newTotalBlocks = 0;
    for (const t of obfuscated.targets) {
      newTotalBlocks += Object.keys(t.blocks).length;
    }
    console.log(`\nBlocks after obfuscation: ${newTotalBlocks} (+${newTotalBlocks - totalBlocks})`);

    await writeSB3(output, obfuscated, zip);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\nDone in ${elapsed}s. Output written to: ${output}`);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();
