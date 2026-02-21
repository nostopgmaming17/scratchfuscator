/**
 * Transform Pipeline
 *
 * Applies all obfuscation transforms in the correct order.
 * Order matters:
 * 1. Fake data (creates variables/lists/broadcasts used by dead code)
 * 2. Renaming (renames variables/lists/broadcasts BEFORE CFF extracts names)
 * 2b. Sensing-of substitution (runs after renaming so names are final,
 *     before CFF so injected set-temp blocks can be decomposed into states)
 * 3. CFF (restructures control flow, injects dead states with dead code)
 * 4. Dead code injection (standalone, on remaining linear code)
 * 5. Constant obfuscation (obfuscates number/string literals including CFF BST comparisons)
 * 6. Scramble (visual scrambling, comment removal)
 */

import { SB3Project, SB3Target, SB3Block, SB3Primitive, isSB3Block } from '../types';
import { ObfuscatorConfig, ObfuscateOptions } from '../config';
import { applyFakeData } from './fakedata';
import { applyCFF } from './cff';
import { applyDeadCode } from './deadcode';
import { applyConstantObfuscation } from './constants';
import { applyRenaming } from './renaming';
import { applyScramble } from './scramble';
import { applySensingOf } from './sensingof';
import { applyBroadcastObf } from './broadcastobf';
import { resetNames } from '../uid';

/**
 * Inline primitive block entries into their parent inputs.
 *
 * Our BlockBuilder creates number/text/broadcast primitives as standalone
 * entries in target.blocks (e.g. [4, "10"]).  The SB3 schema only allows
 * full block objects or variable/list primitives (types 12-13) at the
 * top level.  Types 4-11 must be inlined into the parent input array:
 *   before: input = [1, "primId"],  blocks["primId"] = [4, "10"]
 *   after:  input = [1, [4, "10"]], blocks["primId"] deleted
 */
function inlinePrimitives(project: SB3Project): void {
  for (const target of project.targets) {
    // Collect IDs of primitives that must be inlined (types 4-11)
    const toInline = new Map<string, SB3Primitive>();
    for (const [id, entry] of Object.entries(target.blocks)) {
      if (!Array.isArray(entry)) continue;
      const type = entry[0] as number;
      if (type >= 4 && type <= 11) {
        toInline.set(id, entry as SB3Primitive);
      }
    }
    if (toInline.size === 0) continue;

    // Replace ID references in inputs with inline primitives
    for (const [, entry] of Object.entries(target.blocks)) {
      if (!isSB3Block(entry)) continue;
      for (const inputArr of Object.values(entry.inputs)) {
        for (let i = 1; i < inputArr.length; i++) {
          if (typeof inputArr[i] === 'string' && toInline.has(inputArr[i] as string)) {
            (inputArr as any[])[i] = toInline.get(inputArr[i] as string)!;
          }
        }
      }
    }

    // Delete inlined entries from blocks
    for (const id of toInline.keys()) {
      delete target.blocks[id];
    }
  }
}

export function obfuscate(project: SB3Project, config: ObfuscatorConfig, opts?: ObfuscateOptions): SB3Project {
  // Reset name generator state
  resetNames();

  // Deep clone the project to avoid mutating the original
  const p: SB3Project = JSON.parse(JSON.stringify(project));

  console.log('[obfuscator] Starting obfuscation...');

  // 1. Generate fake data (variables, lists, broadcasts)
  console.log('[obfuscator] Phase 1: Fake data generation');
  applyFakeData(p, config);

  // 2. Renaming (BEFORE CFF so broadcast names are already renamed when CFF extracts them)
  console.log('[obfuscator] Phase 2: Renaming');
  applyRenaming(p, config, opts);

  // 2b. Sensing-of substitution (AFTER renaming so var/sprite names are final,
  //     BEFORE CFF so the injected set-temp block can be split into a separate state)
  console.log('[obfuscator] Phase 2b: Sensing-of substitution');
  applySensingOf(p, config, opts);

  // 3. Control flow flattening
  console.log('[obfuscator] Phase 3: Control flow flattening');
  // Snapshot block IDs before CFF so we can identify CFF-generated blocks
  const preCffBlockIds = new Set<string>();
  for (const target of p.targets) {
    for (const id of Object.keys(target.blocks)) preCffBlockIds.add(`${target.name}\0${id}`);
  }
  applyCFF(p, config, opts);
  // Collect all block IDs created by CFF
  const cffBlockIds = new Set<string>();
  for (const target of p.targets) {
    for (const id of Object.keys(target.blocks)) {
      if (!preCffBlockIds.has(`${target.name}\0${id}`)) cffBlockIds.add(id);
    }
  }
  p._cffBlockIds = cffBlockIds;

  // 3b. Broadcast obfuscation (AFTER CFF so CFF-generated broadcasts are present)
  console.log('[obfuscator] Phase 3b: Broadcast obfuscation');
  applyBroadcastObf(p, config, opts);

  // 4. Standalone dead code injection
  console.log('[obfuscator] Phase 4: Dead code injection');
  applyDeadCode(p, config, opts);

  // 5. Constant obfuscation (AFTER CFF so BST dispatch comparisons get obfuscated)
  console.log('[obfuscator] Phase 5: Constant obfuscation');
  applyConstantObfuscation(p, config, opts);

  // 6. Visual scrambling
  console.log('[obfuscator] Phase 6: Visual scrambling');
  applyScramble(p, config, opts);

  // 7. Inline primitives (fix SB3 schema compliance)
  console.log('[obfuscator] Phase 7: Inlining primitives');
  inlinePrimitives(p);

  console.log('[obfuscator] Obfuscation complete.');
  return p;
}

// Re-export everything for library consumers
export { applyFakeData } from './fakedata';
export { applyCFF } from './cff';
export { applyDeadCode } from './deadcode';
export { applyConstantObfuscation } from './constants';
export { applyRenaming } from './renaming';
export { applyScramble } from './scramble';
export { applySensingOf } from './sensingof';
export { applyBroadcastObf } from './broadcastobf';
