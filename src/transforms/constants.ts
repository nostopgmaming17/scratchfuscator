/**
 * Constant Obfuscation
 *
 * Three ordered sub-passes run per target:
 *   1. String splitting  — TEXT_PRIMITIVE → operator_join tree of substrings
 *   2. String list       — TEXT_PRIMITIVE → data_itemoflist from a stage constants pool
 *   3. Number equations  — MATH_NUM_PRIMITIVE → arithmetic expression tree
 *
 * Running splitting before the list pass means the individual pieces land in
 * the pool rather than the original concatenated string, which increases pool
 * entropy and makes reconstruction harder.
 */

import {
  SB3Target, SB3Block, SB3Project, SB3Primitive,
  isSB3Block, isSB3Primitive,
  INPUT_SAME_BLOCK_SHADOW, INPUT_BLOCK_NO_SHADOW,
  MATH_NUM_PRIMITIVE, TEXT_PRIMITIVE,
} from '../types';
import { BlockBuilder } from '../blocks';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { uid, confusableName, randomInt, randomNumber, randomBool } from '../uid';

export function applyConstantObfuscation(project: SB3Project, config: ObfuscatorConfig, opts?: ObfuscateOptions): void {
  if (!config.constants.enabled) return;

  // Create a global constants list on the stage for string pooling
  const stage = project.targets.find(t => t.isStage);
  if (!stage) return;

  const constListName = confusableName();
  const constListId = uid();
  stage.lists[constListId] = [constListName, []];
  const constPool: string[] = [];
  project._constListInfo = { id: constListId, name: constListName };

  // Block IDs to skip in number equations
  const eq = config.constants.equations;
  let skipIds: Set<string> | undefined;
  if (eq.skipCffBlocks && project._cffBlockIds) {
    skipIds = project._cffBlockIds;
  } else if (eq.skipCffPcBlocks && project._cffPcBlockIds) {
    skipIds = project._cffPcBlockIds;
  }
  // Merge in variable/argument encryption block IDs if configured
  if (eq.skipVarEncryptionBlocks && project._varEncBlockIds) {
    skipIds = skipIds ? new Set([...skipIds, ...project._varEncBlockIds]) : project._varEncBlockIds;
  }
  if (eq.skipArgEncryptionBlocks && project._argEncBlockIds) {
    skipIds = skipIds ? new Set([...skipIds, ...project._argEncBlockIds]) : project._argEncBlockIds;
  }

  for (const target of project.targets) {
    if (!isTargetSelected(target, opts)) continue;

    const bb = new BlockBuilder(target);

    // Sub-pass 1: String splitting (TEXT_PRIMITIVE → operator_join trees)
    if (config.constants.splitStrings) {
      splitStringsInTarget(target, bb, config.constants.stringSplitDepth);
    }

    // Sub-pass 2: String list (TEXT_PRIMITIVE → data_itemoflist from constants pool)
    if (config.constants.obfuscateStrings) {
      obfuscateStringsInTarget(target, bb, constListName, constListId, constPool, stage);
    }

    // Sub-pass 3: Number equations (MATH_NUM_PRIMITIVE → math expression trees)
    if (config.constants.obfuscateNumbers) {
      obfuscateNumbersInTarget(target, bb, config.constants.mathExpressionDepth, skipIds);
    }
  }
}

// Opcodes whose input blocks should NOT be obfuscated
const SKIP_PARENT_OPCODES = new Set([
  'procedures_prototype',
  'procedures_definition',
  'argument_reporter_string_number',
  'argument_reporter_boolean',
]);

// ── Sub-pass 1: String Splitting ──────────────────────────────────
// Replace TEXT_PRIMITIVE literals with operator_join trees of substrings.
// Leaf pieces become standalone TEXT_PRIMITIVE entries that sub-pass 2 pools.

function splitStringsInTarget(target: SB3Target, bb: BlockBuilder, depth: number): void {
  // Snapshot keys — newly created join/literal blocks must not be re-processed
  // by this same pass (they'd be double-split or create infinite loops).
  const keys = Object.keys(target.blocks);

  for (const blockId of keys) {
    const blockOrPrim = target.blocks[blockId];
    if (!isSB3Block(blockOrPrim)) continue;
    const block = blockOrPrim;

    if (SKIP_PARENT_OPCODES.has(block.opcode)) continue;

    for (const [inputName, inputArr] of Object.entries(block.inputs)) {
      if (inputName.startsWith('SUBSTACK')) continue;
      if (inputName === 'custom_block') continue;

      for (let slot = 1; slot < inputArr.length; slot++) {
        const val = inputArr[slot];

        // Standalone block entry referenced by ID: blocks[val] = [10, "str"]
        if (typeof val === 'string') {
          const entry = target.blocks[val];
          if (!entry || !Array.isArray(entry)) continue;
          if ((entry[0] as number) !== TEXT_PRIMITIVE) continue;

          const strVal = String(entry[1]);
          if (strVal === '' || strVal.length < 2 || strVal.length > 200) continue;

          const joinId = splitStringToJoin(bb, strVal, depth);
          bb.setParent(joinId, blockId);
          delete target.blocks[val];
          (inputArr as any[])[slot] = joinId;
          inputArr[0] = INPUT_BLOCK_NO_SHADOW;
          continue;
        }

        // Inline primitive: [10, "str"] already embedded in the input array
        if (!Array.isArray(val)) continue;
        const prim = val as SB3Primitive;
        if ((prim[0] as number) !== TEXT_PRIMITIVE) continue;

        const strVal = String(prim[1]);
        if (strVal === '' || strVal.length < 2 || strVal.length > 200) continue;

        const joinId = splitStringToJoin(bb, strVal, depth);
        bb.setParent(joinId, blockId);
        (inputArr as any[])[slot] = joinId;
        inputArr[0] = INPUT_BLOCK_NO_SHADOW;
      }
    }
  }
}

/**
 * Recursively build an operator_join tree that concatenates to `text`.
 *
 * Leaf nodes are standalone TEXT_PRIMITIVE entries (textLiteral IDs) so that
 * sub-pass 2 can find and pool them just like any other string literal.
 *
 * Returns the ID of the root block.
 */
function splitStringToJoin(bb: BlockBuilder, text: string, depth: number): string {
  // Base case: can't split further — return a text literal leaf
  if (depth <= 0 || text.length < 2) {
    return bb.textLiteral(text);
  }

  // Random split point: 1 ≤ splitAt ≤ length-1 (both pieces non-empty)
  const splitAt = randomInt(1, text.length - 1);
  const left = text.slice(0, splitAt);
  const right = text.slice(splitAt);

  const leftId  = splitStringToJoin(bb, left,  depth - 1);
  const rightId = splitStringToJoin(bb, right, depth - 1);

  const joinId = bb.createBlock({
    opcode: 'operator_join',
    inputs: {
      STRING1: [INPUT_SAME_BLOCK_SHADOW, leftId],
      STRING2: [INPUT_SAME_BLOCK_SHADOW, rightId],
    },
  });

  bb.setParent(leftId,  joinId);
  bb.setParent(rightId, joinId);

  return joinId;
}

// ── Sub-pass 2: String List ───────────────────────────────────────
// Move remaining TEXT_PRIMITIVE literals into a global constants list on
// the Stage, replacing each with  data_itemoflist [constList] (1-based index).

function obfuscateStringsInTarget(
  target: SB3Target,
  bb: BlockBuilder,
  constListName: string,
  constListId: string,
  constPool: string[],
  stage: SB3Target,
): void {
  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    const block = blockOrPrim;

    if (SKIP_PARENT_OPCODES.has(block.opcode)) continue;

    for (const [inputName, inputArr] of Object.entries(block.inputs)) {
      if (inputName.startsWith('SUBSTACK')) continue;
      if (inputName === 'custom_block') continue;

      for (let slot = 1; slot < inputArr.length; slot++) {
        const val = inputArr[slot];

        if (typeof val === 'string') {
          const entry = target.blocks[val];
          if (!entry || !Array.isArray(entry)) continue;
          if ((entry[0] as number) !== TEXT_PRIMITIVE) continue;

          const strVal = String(entry[1]);
          if (strVal === '' || strVal.length > 200) continue;

          let poolIndex = constPool.indexOf(strVal);
          if (poolIndex === -1) {
            constPool.push(strVal);
            (stage.lists[constListId] as [string, any[]])[1].push(strVal);
            poolIndex = constPool.length - 1;
          }

          const indexId = bb.numberLiteral(poolIndex + 1);
          const itemOfId = bb.itemOfList(constListName, constListId, indexId);
          bb.setParent(indexId, itemOfId);
          bb.setParent(itemOfId, blockId);

          delete target.blocks[val];
          (inputArr as any[])[slot] = itemOfId;
          inputArr[0] = INPUT_BLOCK_NO_SHADOW;
          continue;
        }

        if (!Array.isArray(val)) continue;
        const prim = val as SB3Primitive;
        if ((prim[0] as number) !== TEXT_PRIMITIVE) continue;

        const strVal = String(prim[1]);
        if (strVal === '' || strVal.length > 200) continue;

        let poolIndex = constPool.indexOf(strVal);
        if (poolIndex === -1) {
          constPool.push(strVal);
          (stage.lists[constListId] as [string, any[]])[1].push(strVal);
          poolIndex = constPool.length - 1;
        }

        const indexId = bb.numberLiteral(poolIndex + 1);
        const itemOfId = bb.itemOfList(constListName, constListId, indexId);
        bb.setParent(indexId, itemOfId);
        bb.setParent(itemOfId, blockId);

        (inputArr as any[])[slot] = itemOfId;
        inputArr[0] = INPUT_BLOCK_NO_SHADOW;
      }
    }
  }
}

// ── Sub-pass 3: Number Equations ─────────────────────────────────
// Replace MATH_NUM_PRIMITIVE literals with arithmetic expression trees
// that evaluate to the same value at runtime.

function obfuscateNumbersInTarget(
  target: SB3Target,
  bb: BlockBuilder,
  depth: number,
  skipIds?: Set<string>,
): void {
  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    const block = blockOrPrim;

    if (SKIP_PARENT_OPCODES.has(block.opcode)) continue;

    for (const [inputName, inputArr] of Object.entries(block.inputs)) {
      if (inputName.startsWith('SUBSTACK')) continue;
      if (inputName === 'custom_block') continue;

      for (let slot = 1; slot < inputArr.length; slot++) {
        const val = inputArr[slot];

        if (typeof val === 'string') {
          if (skipIds?.has(val)) continue;

          const entry = target.blocks[val];
          if (!entry || !Array.isArray(entry)) continue;
          if ((entry[0] as number) !== MATH_NUM_PRIMITIVE) continue;

          const numVal = Number(entry[1]);
          if (isNaN(numVal) || numVal === 0) continue;

          const exprId = generateMathExpression(bb, numVal, depth);
          delete target.blocks[val];
          (inputArr as any[])[slot] = exprId;
          inputArr[0] = INPUT_BLOCK_NO_SHADOW;
          bb.setParent(exprId, blockId);
          continue;
        }

        if (!Array.isArray(val)) continue;
        const prim = val as SB3Primitive;
        if ((prim[0] as number) !== MATH_NUM_PRIMITIVE) continue;

        const numVal = Number(prim[1]);
        if (isNaN(numVal) || numVal === 0) continue;

        const exprId = generateMathExpression(bb, numVal, depth);
        (inputArr as any[])[slot] = exprId;
        inputArr[0] = INPUT_BLOCK_NO_SHADOW;
        bb.setParent(exprId, blockId);
      }
    }
  }
}

/**
 * Generate a math expression tree that evaluates to the target number.
 * E.g., for 42 with depth 2: ((6 * 8) + (-6)) where 6*8=48, 48+(-6)=42
 */
function generateMathExpression(bb: BlockBuilder, target: number, depth: number): string {
  if (depth <= 0) {
    return bb.numberLiteral(target) as string;
  }

  const strategy = randomInt(1, 3);

  switch (strategy) {
    case 1: {
      // target = a * b + c
      const b = randomInt(2, 15);
      const aTimesB = Math.floor(target / b) * b;
      const a = aTimesB / b;
      const c = target - aTimesB;

      const mulId = (depth > 1)
        ? bb.mathOp('operator_multiply',
            generateMathExpression(bb, a, depth - 1),
            generateMathExpression(bb, b, depth - 1))
        : bb.mathOp('operator_multiply', a, b);

      if (c === 0) return mulId;
      return bb.mathOp('operator_add', mulId, c);
    }
    case 2: {
      // target = a + b where a is a random split
      const a = randomInt(Math.floor(target / 2) - 50, Math.floor(target / 2) + 50);
      const b = target - a;

      if (depth > 1) {
        return bb.mathOp('operator_add',
          generateMathExpression(bb, a, depth - 1),
          generateMathExpression(bb, b, depth - 1));
      }
      return bb.mathOp('operator_add', a, b);
    }
    case 3: {
      // target = a - b
      const b = randomInt(1, 100);
      const a = target + b;

      if (depth > 1) {
        return bb.mathOp('operator_subtract',
          generateMathExpression(bb, a, depth - 1),
          generateMathExpression(bb, b, depth - 1));
      }
      return bb.mathOp('operator_subtract', a, b);
    }
    default:
      return bb.numberLiteral(target) as string;
  }
}
