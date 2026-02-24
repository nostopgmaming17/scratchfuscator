/**
 * Variable Encryption Transform
 *
 * Encodes numeric variable values with a linear transform (a*x + b) on write
 * and the inverse ((x - b) / a) on read. Makes variable values unreadable
 * when inspecting the project at runtime.
 *
 * Only applies to numeric contexts. Cloud variables are always skipped.
 * Runs BEFORE CFF so the injected math blocks get flattened too.
 */

import {
  SB3Target, SB3Block, SB3Project,
  isSB3Block, isSB3Primitive,
  VAR_PRIMITIVE, TEXT_PRIMITIVE,
  INPUT_SAME_BLOCK_SHADOW, INPUT_BLOCK_NO_SHADOW,
} from '../types';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { BlockBuilder } from '../blocks';
import { randomInt, uid } from '../uid';

interface VarEncKeys {
  a: number;
  b: number;
}

/**
 * Collect the set of variable IDs that are cloud variables across all targets.
 */
function collectCloudVarIds(project: SB3Project): Set<string> {
  const ids = new Set<string>();
  for (const target of project.targets) {
    for (const [varId, varData] of Object.entries(target.variables)) {
      if (varData.length === 3 && varData[2] === true) {
        ids.add(varId);
      }
    }
  }
  return ids;
}

/**
 * Generate encryption keys for each eligible variable in a target.
 * Returns a map of varId -> { a, b }.
 */
function generateKeys(
  target: SB3Target,
  cloudIds: Set<string>,
  excluded: Set<string>,
): Map<string, VarEncKeys> {
  const keys = new Map<string, VarEncKeys>();
  for (const [varId, varData] of Object.entries(target.variables)) {
    if (cloudIds.has(varId)) continue;
    if (excluded.has(varData[0])) continue;
    // a in [2,15], b in [-50,50] (avoid 0 for a)
    const a = randomInt(2, 15);
    const b = randomInt(-50, 50);
    keys.set(varId, { a, b });
  }
  return keys;
}

// Opcodes whose reporters produce strings (or could produce strings).
const STRING_PRODUCING_OPCODES = new Set([
  'operator_join',
  'operator_letter_of',
  'sensing_answer',
  'sensing_username',
  'looks_costumenumbername',   // can return name
  'looks_backdropnumbername',  // can return name
  'sensing_of',                // can return string properties
  'data_itemoflist',           // list items can be strings
  'sensing_current',           // returns strings for some options
]);

/**
 * Build a map of proccode -> list of call-site input arrays for each argument.
 * callSiteArgs["myBlock %s %s"][0] = [valueRef1, valueRef2, ...] (all values passed for arg 0)
 */
function buildCallSiteMap(project: SB3Project): Map<string, Map<string, (string | any[] | null)[]>> {
  // proccode -> argId -> [values passed at call sites]
  const result = new Map<string, Map<string, (string | any[] | null)[]>>();

  for (const target of project.targets) {
    for (const [, blockOrPrim] of Object.entries(target.blocks)) {
      if (!isSB3Block(blockOrPrim)) continue;
      if (blockOrPrim.opcode !== 'procedures_call') continue;
      const mutation = blockOrPrim.mutation;
      if (!mutation?.proccode || !mutation.argumentids) continue;

      const proccode = mutation.proccode;
      const argIds: string[] = JSON.parse(mutation.argumentids);

      if (!result.has(proccode)) result.set(proccode, new Map());
      const argMap = result.get(proccode)!;

      for (const argId of argIds) {
        if (!argMap.has(argId)) argMap.set(argId, []);
        const input = blockOrPrim.inputs[argId];
        argMap.get(argId)!.push(input ? (input[1] as any) : null);
      }
    }
  }
  return result;
}

/**
 * For an argument_reporter block, find the proccode and argument ID by walking
 * up to the procedures_definition/prototype.
 */
function resolveArgReporter(
  target: SB3Target,
  block: SB3Block,
): { proccode: string; argId: string } | null {
  const argName = block.fields['VALUE']?.[0];
  if (!argName) return null;

  // Walk up to procedures_definition
  let id = block.parent;
  while (id) {
    const b = target.blocks[id];
    if (!b || !isSB3Block(b)) return null;
    if (b.opcode === 'procedures_definition') {
      const protoRef = b.inputs['custom_block']?.[1];
      if (typeof protoRef !== 'string') return null;
      const proto = target.blocks[protoRef];
      if (!proto || !isSB3Block(proto) || !proto.mutation) return null;

      const proccode = proto.mutation.proccode!;
      const argNames: string[] = JSON.parse(proto.mutation.argumentnames || '[]');
      const argIds: string[] = JSON.parse(proto.mutation.argumentids || '[]');
      const idx = argNames.indexOf(argName);
      if (idx === -1) return null;
      return { proccode, argId: argIds[idx] };
    }
    id = b.parent;
  }
  return null;
}

/**
 * Walk an input value and return true if it could produce a string.
 * Checks inline primitives, and recursively follows block references.
 * For argument reporters, traces what all call sites actually pass.
 */
function couldProduceString(
  target: SB3Target,
  value: string | any[] | null,
  visited: Set<string>,
  callSiteMap: Map<string, Map<string, (string | any[] | null)[]>>,
  project: SB3Project,
): boolean {
  if (value === null) return false;

  // Inline primitive array
  if (Array.isArray(value)) {
    return value[0] === TEXT_PRIMITIVE;
  }

  // Block ID reference
  if (typeof value !== 'string') return false;
  if (visited.has(value)) return false;
  visited.add(value);

  const entry = target.blocks[value];
  if (!entry) return false;

  // Standalone primitive in blocks map
  if (isSB3Primitive(entry)) {
    return entry[0] === TEXT_PRIMITIVE;
  }

  if (!isSB3Block(entry)) return false;

  // Known string-producing opcode
  if (STRING_PRODUCING_OPCODES.has(entry.opcode)) return true;

  // Argument reporter — trace to call sites
  if (entry.opcode === 'argument_reporter_string_number') {
    const resolved = resolveArgReporter(target, entry);
    if (!resolved) return true; // can't resolve — assume unsafe
    const argValues = callSiteMap.get(resolved.proccode)?.get(resolved.argId);
    if (!argValues || argValues.length === 0) return true; // no callers found — assume unsafe
    // Check every value passed at every call site (across all targets)
    for (const callTarget of project.targets) {
      for (const val of argValues) {
        if (couldProduceString(callTarget, val, visited, callSiteMap, project)) {
          return true;
        }
      }
    }
    return false;
  }

  return false;
}

/**
 * Scan all data_setvariableto blocks across all targets and collect variable IDs
 * that could receive a string value. These must be excluded from encryption.
 */
function findStringSetVarIds(project: SB3Project): Set<string> {
  const callSiteMap = buildCallSiteMap(project);
  const unsafe = new Set<string>();
  for (const target of project.targets) {
    for (const [, blockOrPrim] of Object.entries(target.blocks)) {
      if (!isSB3Block(blockOrPrim)) continue;
      if (blockOrPrim.opcode !== 'data_setvariableto') continue;

      const varField = blockOrPrim.fields['VARIABLE'];
      if (!varField || varField.length < 2 || !varField[1]) continue;
      const varId = varField[1];
      if (unsafe.has(varId)) continue; // already flagged

      const valueInput = blockOrPrim.inputs['VALUE'];
      if (!valueInput) continue;

      if (couldProduceString(target, valueInput[1] as any, new Set(), callSiteMap, project)) {
        unsafe.add(varId);
      }
    }
  }
  return unsafe;
}

/**
 * Encode the initial value stored in the variable definition.
 * If the value isn't numeric, skip encoding this variable entirely.
 */
function encodeInitialValues(
  target: SB3Target,
  keys: Map<string, VarEncKeys>,
): void {
  for (const [varId, varData] of Object.entries(target.variables)) {
    const k = keys.get(varId);
    if (!k) continue;
    const val = Number(varData[1]);
    if (isNaN(val)) {
      // Non-numeric initial value — remove from encryption to be safe
      keys.delete(varId);
      continue;
    }
    varData[1] = val * k.a + k.b;
  }
}

/**
 * Wrap `data_setvariableto` blocks: replace VALUE input with (VALUE * a + b).
 */
function wrapSetBlocks(
  target: SB3Target,
  bb: BlockBuilder,
  keys: Map<string, VarEncKeys>,
): void {
  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    if (blockOrPrim.opcode !== 'data_setvariableto') continue;

    const varField = blockOrPrim.fields['VARIABLE'];
    if (!varField || varField.length < 2 || !varField[1]) continue;
    const varId = varField[1];
    const k = keys.get(varId);
    if (!k) continue;

    // Current VALUE input
    const valueInput = blockOrPrim.inputs['VALUE'];
    if (!valueInput) continue;

    const origValue = valueInput[1]; // block ID or inline primitive

    // Build: (origValue * a) + b
    // We need origValue to be a block reference (string ID)
    let origBlockId: string;
    if (typeof origValue === 'string') {
      origBlockId = origValue;
    } else if (Array.isArray(origValue)) {
      // Inline primitive — promote to a standalone block entry so we can reference it
      const primId = uid();
      target.blocks[primId] = origValue as any;
      origBlockId = primId;
    } else {
      continue; // null — skip
    }

    // (origValue * a)
    const mulId = bb.mathOp('operator_multiply', origBlockId, k.a);
    bb.setParent(origBlockId, mulId);

    // (origValue * a) + b
    const addId = bb.mathOp('operator_add', mulId, k.b);
    bb.setParent(mulId, addId);

    // Replace the VALUE input
    blockOrPrim.inputs['VALUE'] = [INPUT_BLOCK_NO_SHADOW, addId];
    bb.setParent(addId, blockId);
  }
}

/**
 * Wrap `data_changevariableby` blocks.
 * `change var by N` is equivalent to `set var to (var + N)`.
 * In encrypted form: set var to ((var_decoded + N) * a + b)
 *   = set var to (((var - b) / a + N) * a + b)
 *   = set var to (var + N*a)
 * So we just multiply the change amount by a.
 */
function wrapChangeBlocks(
  target: SB3Target,
  bb: BlockBuilder,
  keys: Map<string, VarEncKeys>,
): void {
  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    if (blockOrPrim.opcode !== 'data_changevariableby') continue;

    const varField = blockOrPrim.fields['VARIABLE'];
    if (!varField || varField.length < 2 || !varField[1]) continue;
    const varId = varField[1];
    const k = keys.get(varId);
    if (!k) continue;

    const valueInput = blockOrPrim.inputs['VALUE'];
    if (!valueInput) continue;

    const origValue = valueInput[1];
    let origBlockId: string;
    if (typeof origValue === 'string') {
      origBlockId = origValue;
    } else if (Array.isArray(origValue)) {
      const primId = uid();
      target.blocks[primId] = origValue as any;
      origBlockId = primId;
    } else {
      continue;
    }

    // change amount * a
    const mulId = bb.mathOp('operator_multiply', origBlockId, k.a);
    bb.setParent(origBlockId, mulId);

    blockOrPrim.inputs['VALUE'] = [INPUT_BLOCK_NO_SHADOW, mulId];
    bb.setParent(mulId, blockId);
  }
}

/**
 * Wrap variable reads. Anywhere a variable is read (data_variable block or
 * inline [12, name, id] primitive), replace it with ((read - b) / a).
 *
 * For inline primitives in inputs, we replace them with a block chain.
 * For data_variable reporter blocks, we interpose math blocks.
 */
function wrapReads(
  target: SB3Target,
  bb: BlockBuilder,
  keys: Map<string, VarEncKeys>,
): void {
  // Pass 1: Handle data_variable reporter blocks.
  // Collect first so we don't mutate while iterating.
  const reporterEntries: [string, SB3Block][] = [];
  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    if (blockOrPrim.opcode !== 'data_variable') continue;
    const varField = blockOrPrim.fields['VARIABLE'];
    if (!varField || varField.length < 2 || !varField[1]) continue;
    if (!keys.has(varField[1])) continue;
    reporterEntries.push([blockId, blockOrPrim]);
  }

  for (const [blockId, block] of reporterEntries) {
    const varId = block.fields['VARIABLE'][1]!;
    const k = keys.get(varId)!;
    const parentId = block.parent;

    // Build: (readVar - b) / a
    const subId = bb.mathOp('operator_subtract', blockId, k.b);
    bb.setParent(blockId, subId);
    block.parent = subId;

    const divId = bb.mathOp('operator_divide', subId, k.a);
    bb.setParent(subId, divId);

    // Replace references to blockId with divId in the parent block
    if (parentId) {
      const parentBlock = bb.getFullBlock(parentId);
      if (parentBlock) {
        replaceBlockRef(parentBlock, blockId, divId);
        bb.setParent(divId, parentId);
      }
    }
  }

  // Pass 2: Handle inline [12, name, id] primitives in inputs.
  // These appear as array elements inside input arrays.
  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    for (const [inputName, inputArr] of Object.entries(blockOrPrim.inputs)) {
      for (let i = 1; i < inputArr.length; i++) {
        const val = inputArr[i];
        if (!Array.isArray(val)) continue;
        const prim = val as any[];
        if (prim[0] !== VAR_PRIMITIVE || prim.length < 3) continue;
        const varId = prim[2] as string;
        const k = keys.get(varId);
        if (!k) continue;

        // Create a data_variable block + decode chain to replace the inline primitive
        const varName = prim[1] as string;
        const readId = bb.readVariable(varName, varId);
        const subId = bb.mathOp('operator_subtract', readId, k.b);
        bb.setParent(readId, subId);
        const divId = bb.mathOp('operator_divide', subId, k.a);
        bb.setParent(subId, divId);
        bb.setParent(divId, blockId);

        // Replace the inline primitive with a block reference
        (inputArr as any[])[i] = divId;
        inputArr[0] = INPUT_BLOCK_NO_SHADOW;
      }
    }
  }

  // Pass 3: Handle standalone [12, name, id] primitives (top-level variable monitors etc.)
  // These are entries in target.blocks that are just arrays. They're read-only displays,
  // so we leave them alone — Scratch handles them via monitors, not block execution.
}

/**
 * Replace all references to oldId with newId in a block's inputs.
 */
function replaceBlockRef(block: SB3Block, oldId: string, newId: string): void {
  for (const inputArr of Object.values(block.inputs)) {
    for (let i = 1; i < inputArr.length; i++) {
      if (inputArr[i] === oldId) {
        (inputArr as any[])[i] = newId;
      }
    }
  }
}

// ── Procedure argument encryption ────────────────────────────────────

/**
 * For each procedure in a target, determine which arguments are safe to encrypt
 * (i.e. no call site passes a string-producing value). Returns proccode -> argId -> keys.
 */
function generateArgKeys(
  target: SB3Target,
  project: SB3Project,
  callSiteMap: Map<string, Map<string, (string | any[] | null)[]>>,
): Map<string, Map<string, VarEncKeys>> {
  const result = new Map<string, Map<string, VarEncKeys>>();

  for (const [, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    if (blockOrPrim.opcode !== 'procedures_prototype') continue;
    const mutation = blockOrPrim.mutation;
    if (!mutation?.proccode || !mutation.argumentids || !mutation.argumentnames) continue;

    const proccode = mutation.proccode;
    if (result.has(proccode)) continue; // already processed

    const argIds: string[] = JSON.parse(mutation.argumentids);
    const argNames: string[] = JSON.parse(mutation.argumentnames);
    const argDefaults: string[] = JSON.parse(mutation.argumentdefaults || '[]');

    const argKeys = new Map<string, VarEncKeys>();

    for (let i = 0; i < argIds.length; i++) {
      // Skip boolean args (default "false" means boolean type)
      if (argDefaults[i] === 'false') continue;

      // Check all call sites for this argument
      const callValues = callSiteMap.get(proccode)?.get(argIds[i]) ?? [];
      let hasString = false;
      for (const val of callValues) {
        // Check across all targets since call sites may be anywhere
        for (const t of project.targets) {
          if (couldProduceString(t, val, new Set(), callSiteMap, project)) {
            hasString = true;
            break;
          }
        }
        if (hasString) break;
      }
      if (hasString) continue;

      argKeys.set(argIds[i], {
        a: randomInt(2, 15),
        b: randomInt(-50, 50),
      });
    }

    if (argKeys.size > 0) {
      result.set(proccode, argKeys);
    }
  }
  return result;
}

/**
 * Wrap procedures_call inputs with (value * a + b) for encrypted arguments.
 */
function wrapCallSiteInputs(
  target: SB3Target,
  bb: BlockBuilder,
  allArgKeys: Map<string, Map<string, VarEncKeys>>,
): void {
  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    if (blockOrPrim.opcode !== 'procedures_call') continue;
    const mutation = blockOrPrim.mutation;
    if (!mutation?.proccode) continue;

    const argKeys = allArgKeys.get(mutation.proccode);
    if (!argKeys) continue;

    for (const [argId, k] of argKeys) {
      const input = blockOrPrim.inputs[argId];
      if (!input) continue;

      const origValue = input[1];
      let origBlockId: string;
      if (typeof origValue === 'string') {
        origBlockId = origValue;
      } else if (Array.isArray(origValue)) {
        const primId = uid();
        target.blocks[primId] = origValue as any;
        origBlockId = primId;
      } else {
        continue;
      }

      // (value * a) + b
      const mulId = bb.mathOp('operator_multiply', origBlockId, k.a);
      bb.setParent(origBlockId, mulId);
      const addId = bb.mathOp('operator_add', mulId, k.b);
      bb.setParent(mulId, addId);

      blockOrPrim.inputs[argId] = [INPUT_BLOCK_NO_SHADOW, addId];
      bb.setParent(addId, blockId);
    }
  }
}

/**
 * Wrap argument_reporter_string_number reads with ((value - b) / a).
 */
function wrapArgReporterReads(
  target: SB3Target,
  bb: BlockBuilder,
  allArgKeys: Map<string, Map<string, VarEncKeys>>,
): void {
  // Collect first to avoid mutating while iterating
  const reporters: [string, SB3Block, VarEncKeys][] = [];

  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    if (blockOrPrim.opcode !== 'argument_reporter_string_number') continue;

    const resolved = resolveArgReporter(target, blockOrPrim);
    if (!resolved) continue;

    const argKeys = allArgKeys.get(resolved.proccode);
    if (!argKeys) continue;
    const k = argKeys.get(resolved.argId);
    if (!k) continue;

    reporters.push([blockId, blockOrPrim, k]);
  }

  for (const [blockId, block, k] of reporters) {
    const parentId = block.parent;

    // (argValue - b) / a
    const subId = bb.mathOp('operator_subtract', blockId, k.b);
    bb.setParent(blockId, subId);
    block.parent = subId;

    const divId = bb.mathOp('operator_divide', subId, k.a);
    bb.setParent(subId, divId);

    if (parentId) {
      const parentBlock = bb.getFullBlock(parentId);
      if (parentBlock) {
        replaceBlockRef(parentBlock, blockId, divId);
        bb.setParent(divId, parentId);
      }
    }
  }
}

// ── Helpers for tracking created block IDs ───────────────────────────

function snapshotBlockIds(project: SB3Project): Set<string> {
  const ids = new Set<string>();
  for (const target of project.targets) {
    for (const id of Object.keys(target.blocks)) ids.add(id);
  }
  return ids;
}

function diffBlockIds(before: Set<string>, project: SB3Project): Set<string> {
  const created = new Set<string>();
  for (const target of project.targets) {
    for (const id of Object.keys(target.blocks)) {
      if (!before.has(id)) created.add(id);
    }
  }
  return created;
}

// ── Main entry point ─────────────────────────────────────────────────

export function applyVarEncryption(
  project: SB3Project,
  config: ObfuscatorConfig,
  opts?: ObfuscateOptions,
): void {
  if (!config.varEncryption.enabled) return;

  const cloudIds = collectCloudVarIds(project);
  const callSiteMap = buildCallSiteMap(project);
  const stringVarIds = findStringSetVarIds(project);
  const excluded = new Set(
    (config.varEncryption.excludeVariables ?? []).map(s => s.trim()),
  );

  // ── Variable encryption ──
  const preVarEnc = snapshotBlockIds(project);

  for (const target of project.targets) {
    if (!isTargetSelected(target, opts)) continue;

    const keys = generateKeys(target, cloudIds, excluded);
    // Remove variables that could receive string values at runtime
    for (const varId of stringVarIds) keys.delete(varId);
    if (keys.size === 0) continue;

    encodeInitialValues(target, keys);

    const bb = new BlockBuilder(target);

    // Order matters: wrap writes before reads so we don't accidentally
    // double-transform a read that was just injected by a write wrapper.
    wrapSetBlocks(target, bb, keys);
    wrapChangeBlocks(target, bb, keys);
    wrapReads(target, bb, keys);

    // For stage variables, also wrap reads in other selected targets
    if (target.isStage) {
      for (const otherTarget of project.targets) {
        if (otherTarget === target) continue;
        if (!isTargetSelected(otherTarget, opts)) continue;
        const otherBb = new BlockBuilder(otherTarget);
        wrapReads(otherTarget, otherBb, keys);
      }
    }
  }

  project._varEncBlockIds = diffBlockIds(preVarEnc, project);

  // ── Procedure argument encryption ──
  const preArgEnc = snapshotBlockIds(project);

  for (const target of project.targets) {
    if (!isTargetSelected(target, opts)) continue;

    const argKeys = generateArgKeys(target, project, callSiteMap);
    if (argKeys.size === 0) continue;

    const bb = new BlockBuilder(target);

    // Wrap call site inputs (encode) — must search ALL targets since
    // calls to this target's procedures could be in any target
    for (const callTarget of project.targets) {
      if (!isTargetSelected(callTarget, opts)) continue;
      const callBb = new BlockBuilder(callTarget);
      wrapCallSiteInputs(callTarget, callBb, argKeys);
    }

    // Wrap argument reporter reads (decode) — only in the defining target
    wrapArgReporterReads(target, bb, argKeys);
  }

  project._argEncBlockIds = diffBlockIds(preArgEnc, project);
}
