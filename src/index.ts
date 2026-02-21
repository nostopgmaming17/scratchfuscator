/**
 * Scratchfuscator - Library Entry Point
 *
 * Can be used as:
 * 1. A Node.js library: import { obfuscateSB3File, obfuscateProject } from 'scratchfuscator'
 * 2. A CLI tool: npx scratchfuscator input.sb3 -o output.sb3 --preset heavy
 * 3. Console-injectable: paste the console bundle into browser devtools
 */

export { SB3Project, SB3Target, SB3Block } from './types';
export {
  ObfuscatorConfig,
  PRESETS, PRESET_LIGHT, PRESET_MEDIUM, PRESET_HEAVY, PRESET_MAX,
  mergeConfig,
} from './config';
export { obfuscate } from './transforms';
export { readSB3, writeSB3, parseProjectJSON } from './sb3';
export { resetNames } from './uid';

import { readSB3, writeSB3 } from './sb3';
import { obfuscate } from './transforms';
import { ObfuscatorConfig, PRESET_MEDIUM } from './config';
import { SB3Project } from './types';

/**
 * Obfuscate an .sb3 file on disk.
 * Reads the file, applies transforms, writes to output path.
 */
export async function obfuscateSB3File(
  inputPath: string,
  outputPath: string,
  config: ObfuscatorConfig = PRESET_MEDIUM,
): Promise<void> {
  const { project, zip } = await readSB3(inputPath);
  const obfuscated = obfuscate(project, config);

  // Replace the project.json in the zip
  zip.file('project.json', JSON.stringify(obfuscated));
  await writeSB3(outputPath, obfuscated, zip);
}

/**
 * Obfuscate a raw project JSON object (for console injection mode).
 */
export function obfuscateProject(
  project: SB3Project,
  config: ObfuscatorConfig = PRESET_MEDIUM,
): SB3Project {
  return obfuscate(project, config);
}
