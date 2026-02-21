/**
 * Console-Injectable Scratchfuscator
 *
 * This file generates a self-contained script that can be pasted into
 * the browser console on the Scratch editor (scratch.mit.edu/projects/xxx/editor).
 *
 * It accesses the Scratch VM via the global `vm` variable and operates
 * on the VM's internal block format, then serializes and reloads.
 *
 * Usage: paste the built output of this file into browser devtools console.
 *
 * For building: this file is the template. The build step bundles all
 * transforms into a single IIFE.
 *
 * Alternatively, this can be run directly by calling:
 *   window.__scratchObfuscate(config?)
 */

import { SB3Project, SB3Target, SB3Block, SB3Primitive, isSB3Block } from './types';
import { ObfuscatorConfig, ObfuscateOptions, PRESETS, PRESET_MEDIUM, PRESET_HEAVY, PRESET_MAX, mergeConfig } from './config';
import { obfuscate } from './transforms';

/**
 * Extract a project JSON from the Scratch VM's internal state.
 * This mimics what vm.toJSON() / vm.saveProjectSb3() does internally.
 */
function extractProjectFromVM(vm: any): SB3Project {
  // Use the VM's built-in serializer
  const json = vm.toJSON();
  return JSON.parse(json);
}

// ── Minimal ZIP builder (no dependencies) ──────────────────────
// Creates a valid .sb3 (ZIP with project.json) as an ArrayBuffer
// so vm.loadProject receives data through the standard .sb3 path.

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createMinimalSB3(project: SB3Project): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(project));
  const fname = new TextEncoder().encode('project.json');
  const crc = crc32(jsonBytes);

  const localSize = 30 + fname.length;
  const centralSize = 46 + fname.length;
  const totalSize = localSize + jsonBytes.length + centralSize + 22;

  const buf = new ArrayBuffer(totalSize);
  const v = new DataView(buf);
  const b = new Uint8Array(buf);
  let o = 0;

  // Local file header
  v.setUint32(o, 0x04034b50, true); o += 4;
  v.setUint16(o, 20, true); o += 2;    // version needed
  v.setUint16(o, 0, true); o += 2;     // flags
  v.setUint16(o, 0, true); o += 2;     // compression (stored)
  v.setUint16(o, 0, true); o += 2;     // mod time
  v.setUint16(o, 0, true); o += 2;     // mod date
  v.setUint32(o, crc, true); o += 4;
  v.setUint32(o, jsonBytes.length, true); o += 4;  // compressed size
  v.setUint32(o, jsonBytes.length, true); o += 4;  // uncompressed size
  v.setUint16(o, fname.length, true); o += 2;
  v.setUint16(o, 0, true); o += 2;     // extra length
  b.set(fname, o); o += fname.length;

  // File data
  b.set(jsonBytes, o); o += jsonBytes.length;

  // Central directory header
  const centralStart = o;
  v.setUint32(o, 0x02014b50, true); o += 4;
  v.setUint16(o, 20, true); o += 2;    // version made by
  v.setUint16(o, 20, true); o += 2;    // version needed
  v.setUint16(o, 0, true); o += 2;     // flags
  v.setUint16(o, 0, true); o += 2;     // compression
  v.setUint16(o, 0, true); o += 2;     // mod time
  v.setUint16(o, 0, true); o += 2;     // mod date
  v.setUint32(o, crc, true); o += 4;
  v.setUint32(o, jsonBytes.length, true); o += 4;
  v.setUint32(o, jsonBytes.length, true); o += 4;
  v.setUint16(o, fname.length, true); o += 2;
  v.setUint16(o, 0, true); o += 2;     // extra length
  v.setUint16(o, 0, true); o += 2;     // comment length
  v.setUint16(o, 0, true); o += 2;     // disk number
  v.setUint16(o, 0, true); o += 2;     // internal attrs
  v.setUint32(o, 0, true); o += 4;     // external attrs
  v.setUint32(o, 0, true); o += 4;     // local header offset
  b.set(fname, o); o += fname.length;

  // End of central directory
  v.setUint32(o, 0x06054b50, true); o += 4;
  v.setUint16(o, 0, true); o += 2;     // disk number
  v.setUint16(o, 0, true); o += 2;     // disk with central dir
  v.setUint16(o, 1, true); o += 2;     // entries on disk
  v.setUint16(o, 1, true); o += 2;     // total entries
  v.setUint32(o, centralSize, true); o += 4;  // central dir size
  v.setUint32(o, centralStart, true); o += 4; // central dir offset
  v.setUint16(o, 0, true); o += 2;     // comment length

  return buf;
}

/**
 * Reload an obfuscated project into the VM by creating a proper .sb3 ZIP
 * and loading through the standard ArrayBuffer path.
 */
async function loadProjectIntoVM(vm: any, project: SB3Project): Promise<void> {
  const sb3 = createMinimalSB3(project);
  await vm.loadProject(sb3);
}

/**
 * Extract the Scratch VM from the React/Redux store via #app fiber tree.
 * This is the most reliable method across Scratch editor versions.
 */
function findVM(): any {
  // Method 1: already exposed as window.vm
  if ((globalThis as any).vm) return (globalThis as any).vm;

  // Method 2: extract from React fiber on #app -> Redux store -> scratchGui.vm
  try {
    const app = document.getElementById('app');
    if (app) {
      const key = Object.getOwnPropertyNames(app).find(
        v => typeof (app as any)[v] === 'object'
      );
      if (key) {
        const vm = (app as any)[key]?.child?.pendingProps?.store?.getState?.()?.scratchGui?.vm;
        if (vm) return vm;
      }
    }
  } catch (_) { /* ignore */ }

  // Method 3: walk React fiber tree from gui element
  try {
    const guiElement = document.querySelector('[class^="gui_"]');
    if (guiElement) {
      const fiberKey = Object.keys(guiElement).find(
        k => k.startsWith('__reactInternalInstance') || k.startsWith('__reactFiber')
      );
      if (fiberKey) {
        let fiber = (guiElement as any)[fiberKey];
        for (let i = 0; i < 50 && fiber; i++) {
          const vm = fiber.memoizedProps?.vm || fiber.pendingProps?.vm;
          if (vm) return vm;
          fiber = fiber.return;
        }
      }
    }
  } catch (_) { /* ignore */ }

  return null;
}

/**
 * Main console-injectable obfuscation function.
 *
 * @param configOrPreset - Preset name ("light"/"medium"/"heavy"/"max") or full config object.
 * @param opts - Runtime options: excludeNames (vars/lists/broadcasts to skip renaming),
 *               onlySprites (sprite names to obfuscate; all others are left untouched).
 *
 * Examples:
 *   __scratchObfuscate("heavy")
 *   __scratchObfuscate("max", { onlySprites: ["AntiCheat"] })
 *   __scratchObfuscate("heavy", { excludeNames: ["score", "lives"], onlySprites: ["Player"] })
 */
async function consoleObfuscate(configOrPreset?: ObfuscatorConfig | string, opts?: ObfuscateOptions): Promise<void> {
  // Find the VM
  const vm = findVM();
  if (!vm) {
    console.error('[scratchfuscator] Could not find Scratch VM. Make sure you are on the Scratch editor page.');
    return;
  }
  // Expose it globally for reuse
  (globalThis as any).vm = vm;

  // Resolve config
  let config: ObfuscatorConfig;
  if (typeof configOrPreset === 'string') {
    config = PRESETS[configOrPreset] || PRESET_MEDIUM;
  } else if (configOrPreset) {
    config = configOrPreset;
  } else {
    config = PRESET_MEDIUM;
  }

  if (opts?.onlySprites?.length) {
    console.log(`[scratchfuscator] Only sprites: ${opts.onlySprites.join(', ')}`);
  } else if (opts?.excludeSprites?.length) {
    console.log(`[scratchfuscator] Excluded sprites: ${opts.excludeSprites.join(', ')}`);
  }
  if (opts?.excludeNames?.length) {
    console.log(`[scratchfuscator] Excluded from renaming: ${opts.excludeNames.join(', ')}`);
  }

  console.log('[scratchfuscator] Extracting project from VM...');
  const project = extractProjectFromVM(vm);

  console.log(`[scratchfuscator] Project has ${project.targets.length} targets`);
  let totalBlocks = 0;
  for (const t of project.targets) {
    totalBlocks += Object.keys(t.blocks).length;
  }
  console.log(`[scratchfuscator] Total blocks: ${totalBlocks}`);

  const startTime = performance.now();

  console.log('[scratchfuscator] Obfuscating...');
  const obfuscated = obfuscate(project, config, opts);

  let newTotalBlocks = 0;
  for (const t of obfuscated.targets) {
    newTotalBlocks += Object.keys(t.blocks).length;
  }

  console.log(`[scratchfuscator] Blocks: ${totalBlocks} -> ${newTotalBlocks} (+${newTotalBlocks - totalBlocks})`);

  console.log('[scratchfuscator] Loading obfuscated project back into VM...');
  await loadProjectIntoVM(vm, obfuscated);

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`[scratchfuscator] Done in ${elapsed}s!`);
  console.log('[scratchfuscator] The project is now obfuscated in the editor. Save it to download the .sb3.');
}

// ── Self-executing when pasted into console ──────────────────────

// Expose as a global function
(globalThis as any).__scratchObfuscate = consoleObfuscate;

// Also expose presets and config builder
(globalThis as any).__scratchObfuscatorPresets = PRESETS;
(globalThis as any).__scratchObfuscatorMergeConfig = mergeConfig;

// Auto-execute when pasted into console
(async () => {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║         Scratchfuscator - Console Mode              ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║  Presets: light, medium, heavy, max                    ║');
  console.log('║                                                        ║');
  console.log('║  Quick start:                                          ║');
  console.log('║    __scratchObfuscate("heavy")                         ║');
  console.log('║                                                        ║');
  console.log('║  Only obfuscate specific sprites:                      ║');
  console.log('║    __scratchObfuscate("max", {                         ║');
  console.log('║      onlySprites: ["AntiCheat", "Player"]              ║');
  console.log('║    })                                                   ║');
  console.log('║                                                        ║');
  console.log('║  Skip specific sprites (obfuscate all others):         ║');
  console.log('║    __scratchObfuscate("max", {                         ║');
  console.log('║      excludeSprites: ["Thumbnail", "UI"]               ║');
  console.log('║    })                                                   ║');
  console.log('║                                                        ║');
  console.log('║  Keep specific var/list/broadcast names intact:        ║');
  console.log('║    __scratchObfuscate("heavy", {                       ║');
  console.log('║      excludeNames: ["score", "lives", "myBroadcast"]   ║');
  console.log('║    })                                                   ║');
  console.log('║                                                        ║');
  console.log('║  Tune sensing-of substitution (mergeConfig):           ║');
  console.log('║    __scratchObfuscate(__scratchObfuscatorMergeConfig(  ║');
  console.log('║      "max", { sensingOf: { probability: 1 } }))        ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');

  const vm = findVM();
  if (vm) {
    (globalThis as any).vm = vm;
    console.log('[scratchfuscator] VM detected! Ready to obfuscate.');
    console.log('[scratchfuscator] Run: __scratchObfuscate("medium")');
  } else {
    console.error('[scratchfuscator] Could not find Scratch VM.');
    console.error('[scratchfuscator] Make sure you are on the Scratch editor page.');
  }
})();

export { consoleObfuscate };
