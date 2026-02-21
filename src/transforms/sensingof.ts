/**
 * Sensing-of Variable Substitution Transform
 *
 * Replaces data_variable reporter blocks with sensing_of blocks that read
 * the same variable indirectly via Scratch's sprite sensing mechanism.
 * The OBJECT operand of sensing_of is read from a temp variable (not a
 * hard-coded sprite name string), which:
 *   - Hides which sprite's data is being read from static analysis
 *   - Correctly follows sprite renaming (the var holds the renamed name)
 *   - Produces two injected blocks that CFF may split into separate states,
 *     but which always execute back-to-back (no yield between them)
 *
 * For each transformed data_variable read, two operations are generated:
 *   1. set [tempVar] to [sprite-or-stage name]     ← injected before ancestor stack block
 *   2. sensing_of [varName v] of (tempVar)          ← replaces the data_variable reporter
 *
 * Scope restrictions:
 *   - Only non-stage sprite targets are transformed (sprites can sense Stage
 *     variables; the stage has no other sprite to sense from)
 *   - Globals (Stage variables): safe in any script type
 *   - Locals (sprite-own variables): only in event_whenflagclicked scripts
 *     because green-flag scripts never run on clones, so
 *     sensing_of [localVar] of [spriteName] reliably reads the original
 *     sprite's copy of the variable
 *
 * Two separate temp variables are used per target:
 *   tempGlobVar  — always holds "_stage_",    used for global reads
 *   tempLocVar   — always holds target.name,  used for local reads
 * Using two vars avoids conflicts when a single statement block contains
 * both a global and a local variable read as inputs.
 *
 * Pipeline position: after Renaming (names already final), before CFF
 * (so CFF can decompose the injected set-temp + parent block pair).
 */

import {
  SB3Project, SB3Target, SB3Primitive, isSB3Block,
  INPUT_BLOCK_NO_SHADOW, INPUT_DIFF_BLOCK_SHADOW, VAR_PRIMITIVE,
} from '../types';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { BlockBuilder } from '../blocks';
import { confusableName } from '../uid';

// ── Main entry point ──────────────────────────────────────────────

export function applySensingOf(
  project: SB3Project,
  config: ObfuscatorConfig,
  opts?: ObfuscateOptions,
): void {
  if (!config.sensingOf.enabled) return;
  if (!config.sensingOf.globals && !config.sensingOf.locals) return;

  const stage = project.targets.find(t => t.isStage);
  if (!stage) return;

  // All variable IDs that live on the Stage (globals)
  const globalVarIds = new Set(Object.keys(stage.variables));

  for (const target of project.targets) {
    if (target.isStage) continue;
    if (!isTargetSelected(target, opts)) continue;
    applySensingOfToTarget(target, stage, globalVarIds, config);
  }
}

// ── Per-target pass ───────────────────────────────────────────────

function applySensingOfToTarget(
  target: SB3Target,
  stage: SB3Target,
  globalVarIds: Set<string>,
  config: ObfuscatorConfig,
): void {
  const bb = new BlockBuilder(target);

  // Set of variable IDs that are local to this sprite
  const localVarIds = new Set(Object.keys(target.variables));

  // Two shared temp variables — one for global reads, one for local reads.
  // Keeping them separate prevents a conflict when a single stack block has
  // both a global and a local variable read as inputs.
  const tempGlobVarName = confusableName(50);
  const tempGlobVarId = bb.createVariable(tempGlobVarName, '');

  const tempLocVarName = confusableName(50);
  const tempLocVarId = bb.createVariable(tempLocVarName, '');

  // Helper: resolve the CURRENT (potentially renamed) variable name by ID.
  // Always reads from the authoritative source (target.variables / stage.variables)
  // so it picks up names after renaming, even if inline primitives somehow weren't updated.
  function resolveVarName(varId: string, isGlobal: boolean): string | null {
    const store = isGlobal ? stage.variables : target.variables;
    const entry = store[varId];
    return entry ? entry[0] : null;
  }

  // ── Collect candidates ──────────────────────────────────────────
  // Variable references come in TWO forms in SB3:
  //   1. Block-form: separate entry in target.blocks with opcode 'data_variable'
  //   2. Primitive-form: inline [12, name, id] inside a parent's input array
  // We must handle BOTH.

  interface VarCandidate {
    varName: string;
    varId: string;
    isGlobal: boolean;
    /** For block-form: the block ID in target.blocks */
    blockId?: string;
    /** For primitive-form: the parent block ID + input key + array index */
    parentId?: string;
    inputKey?: string;
    inputIndex?: number;
  }

  const candidates: VarCandidate[] = [];

  // 1. Block-form candidates: data_variable blocks in target.blocks
  for (const [id, b] of Object.entries(target.blocks)) {
    if (!isSB3Block(b) || b.opcode !== 'data_variable' || b.topLevel) continue;
    const varField = b.fields['VARIABLE'];
    if (!varField || !varField[1]) continue;
    const varId = varField[1] as string;
    const varName = varField[0];
    const isGlobal = globalVarIds.has(varId);
    const isLocal = localVarIds.has(varId);
    if (!isGlobal && !isLocal) continue;
    if (isGlobal && !config.sensingOf.globals) continue;
    if (isLocal && !config.sensingOf.locals) continue;
    candidates.push({ varName, varId, isGlobal, blockId: id });
  }

  // 2. Primitive-form candidates: [12, name, id] inside block inputs
  for (const [parentId, b] of Object.entries(target.blocks)) {
    if (!isSB3Block(b)) continue;
    for (const [inputKey, inputArr] of Object.entries(b.inputs)) {
      // Skip SUBSTACK inputs — those hold statement blocks, not reporters
      if (inputKey.startsWith('SUBSTACK')) continue;
      for (let i = 1; i < inputArr.length; i++) {
        const el = inputArr[i];
        if (!Array.isArray(el)) continue;
        const prim = el as SB3Primitive;
        if (prim[0] !== VAR_PRIMITIVE) continue;
        // prim = [12, name, id]
        const varName = prim[1] as string;
        const varId = prim[2] as string;
        if (!varId) continue;
        const isGlobal = globalVarIds.has(varId);
        const isLocal = localVarIds.has(varId);
        if (!isGlobal && !isLocal) continue;
        if (isGlobal && !config.sensingOf.globals) continue;
        if (isLocal && !config.sensingOf.locals) continue;
        candidates.push({ varName, varId, isGlobal, parentId, inputKey, inputIndex: i });
      }
    }
  }

  for (const cand of candidates) {
    // Probabilistic filter
    if (Math.random() > config.sensingOf.probability) continue;

    // Determine effective parent block ID for hat-block lookup
    const effectiveParentId = cand.blockId
      ? (isSB3Block(target.blocks[cand.blockId]) ? (target.blocks[cand.blockId] as any).parent : null)
      : cand.parentId;

    // For local vars: only safe inside green-flag scripts
    if (!cand.isGlobal) {
      const startId = cand.blockId || cand.parentId;
      if (!startId) continue;
      const hatId = findHatBlock(target, startId);
      if (!hatId) continue;
      const hat = target.blocks[hatId];
      if (!isSB3Block(hat) || hat.opcode !== 'event_whenflagclicked') continue;
    }

    // Find ancestor stack block for set-temp injection
    const stackStartId = cand.blockId || cand.parentId;
    if (!stackStartId) continue;
    // For block-form, the data_variable itself has a parent → use findAncestorStackBlock from it
    // For primitive-form, the parentId IS a block → find its stack ancestor
    const stackBlockId = cand.blockId
      ? findAncestorStackBlock(target, cand.blockId)
      : findAncestorStackBlock(target, cand.parentId!);
    if (!stackBlockId) continue;

    // Choose temp var and object name
    const tempVarName = cand.isGlobal ? tempGlobVarName : tempLocVarName;
    const tempVarId   = cand.isGlobal ? tempGlobVarId   : tempLocVarId;
    const objectName  = cand.isGlobal ? '_stage_' : target.name;

    // ── Step 1: create  set [tempVar] to [objectName]  ──────────
    const setTempId = bb.setVariable(tempVarName, tempVarId, objectName);

    // ── Step 2: splice setTemp into the sequence before stackBlock ──
    insertBefore(target, stackBlockId, setTempId);

    // ── Step 3: build sensing_of with dynamic OBJECT ─────────────
    const menuId = bb.createBlock({
      opcode: 'sensing_of_object_menu',
      fields: { OBJECT: [objectName, null] },
      shadow: true,
    });

    const objReaderId = bb.createBlock({
      opcode: 'data_variable',
      fields: { VARIABLE: [tempVarName, tempVarId] },
    });

    const sensingId = bb.createBlock({
      opcode: 'sensing_of',
      inputs: {
        OBJECT: [INPUT_DIFF_BLOCK_SHADOW, objReaderId, menuId],
      },
      fields: { PROPERTY: [resolveVarName(cand.varId, cand.isGlobal) ?? cand.varName, null] },
    });

    bb.setParent(menuId, sensingId);
    bb.setParent(objReaderId, sensingId);

    // ── Step 4: swap the old variable ref for sensing_of ────
    if (cand.blockId) {
      // Block-form: replace input ref in parent, delete old block
      const varBlock = target.blocks[cand.blockId];
      if (!isSB3Block(varBlock)) continue;
      const parentId = varBlock.parent;
      if (!parentId) continue;
      bb.setParent(sensingId, parentId);
      (target.blocks[sensingId] as any).parent = parentId;
      replaceInputRef(target, parentId, cand.blockId, sensingId);
      bb.deleteBlock(cand.blockId);
    } else {
      // Primitive-form: replace inline primitive in parent's input array with sensing_of block ID
      const parentBlock = target.blocks[cand.parentId!];
      if (!isSB3Block(parentBlock)) continue;
      const inputArr = parentBlock.inputs[cand.inputKey!];
      if (!inputArr) continue;
      // Change input type: was [1, [12,name,id]] → now [INPUT_DIFF_BLOCK_SHADOW, sensingId, menuShadow]
      // But we already have a full sensing_of block so just reference it
      (inputArr as any[])[cand.inputIndex!] = sensingId;
      // If input type was 1 (SAME_BLOCK_SHADOW), change to 2 (BLOCK_NO_SHADOW) since sensing_of is not a shadow
      if (inputArr[0] === 1) (inputArr as any[])[0] = INPUT_BLOCK_NO_SHADOW;
      bb.setParent(sensingId, cand.parentId!);
      (target.blocks[sensingId] as any).parent = cand.parentId!;
    }
  }
}

// ── findHatBlock ──────────────────────────────────────────────────
// Walk parent links until we reach a topLevel block (the hat).

function findHatBlock(target: SB3Target, startId: string): string | null {
  let cur = startId;
  for (let depth = 0; depth < 200; depth++) {
    const b = target.blocks[cur];
    if (!isSB3Block(b)) return null;
    if (b.topLevel) return cur;
    if (!b.parent) return null;
    cur = b.parent;
  }
  return null;
}

// ── findAncestorStackBlock ────────────────────────────────────────
// Returns the ID of the nearest ancestor block that occupies a
// statement (stack) position:
//   - pointed to by parent.next  (sequential chain)
//   - first block of a SUBSTACK* input on the parent
//
// We walk UP via parent links.  If `cur` is a reporter nested inside
// parent's reporter inputs (CONDITION, VALUE, NUM1 …), we continue
// walking.  When we find cur in parent.next or a SUBSTACK input, cur
// IS the stack block to insert before.
//
// Returns null if the block is inside a topLevel hat (don't insert
// before hats) or if the chain is malformed.

function findAncestorStackBlock(target: SB3Target, startId: string): string | null {
  let cur = startId;
  for (let depth = 0; depth < 100; depth++) {
    const b = target.blocks[cur];
    if (!isSB3Block(b)) return null;
    if (b.topLevel) return null; // don't insert before a hat

    const parentId = b.parent;
    if (!parentId) return null;

    const parent = target.blocks[parentId];
    if (!isSB3Block(parent)) return null;

    // Sequential: parent's next pointer leads directly to cur
    if (parent.next === cur) return cur;

    // First block of a substack body (SUBSTACK, SUBSTACK2 …)
    for (const [key, inputArr] of Object.entries(parent.inputs)) {
      if (
        key.startsWith('SUBSTACK') &&
        inputArr[1] === cur &&
        (inputArr[0] === INPUT_BLOCK_NO_SHADOW || inputArr[0] === INPUT_DIFF_BLOCK_SHADOW)
      ) {
        return cur;
      }
    }

    // cur is a reporter nested in parent's non-SUBSTACK input — walk up
    cur = parentId;
  }
  return null;
}

// ── insertBefore ──────────────────────────────────────────────────
// Splices newId into the chain immediately before stackId.
//
// Before:  ... → [prev] → [stackId] → ...   (or [prev] SUBSTACK→ [stackId])
// After:   ... → [prev] → [newId] → [stackId] → ...

function insertBefore(target: SB3Target, stackId: string, newId: string): void {
  const stackBlock = target.blocks[stackId];
  const newBlock = target.blocks[newId];
  if (!isSB3Block(stackBlock) || !isSB3Block(newBlock)) return;

  const prevId = stackBlock.parent; // whatever currently points to stackId

  // Relink new block
  newBlock.parent = prevId;
  newBlock.next = stackId;
  stackBlock.parent = newId;

  if (!prevId) return;
  const prev = target.blocks[prevId];
  if (!isSB3Block(prev)) return;

  // Case A: sequential — prev.next === stackId
  if (prev.next === stackId) {
    prev.next = newId;
    return;
  }

  // Case B: substack — stackId appears as a SUBSTACK* input value on prev
  for (const [, inputArr] of Object.entries(prev.inputs)) {
    if (inputArr[1] === stackId) {
      (inputArr as any[])[1] = newId;
      return;
    }
  }
}

// ── replaceInputRef ───────────────────────────────────────────────
// In parentId's inputs array, replace every occurrence of oldId with newId.

function replaceInputRef(
  target: SB3Target,
  parentId: string,
  oldId: string,
  newId: string,
): void {
  const parent = target.blocks[parentId];
  if (!isSB3Block(parent)) return;
  for (const [, inputArr] of Object.entries(parent.inputs)) {
    for (let i = 1; i < inputArr.length; i++) {
      if (inputArr[i] === oldId) {
        (inputArr as any[])[i] = newId;
        return;
      }
    }
  }
}
