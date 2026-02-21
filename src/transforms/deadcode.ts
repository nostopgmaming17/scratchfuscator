/**
 * Dead Code Injection
 *
 * Two modes:
 * 1. Standalone: injects dead if-branches around existing blocks
 * 2. CFF-integrated: generates dead code chains for unreachable CFF states
 *
 * Dead code types:
 * - Static: always-false conditions wrapping fake operations
 * - Dynamic: opaque predicates that evaluate at runtime but are provably always true/false
 * - Builtin templates: curated realistic-looking code patterns
 */

import {
  SB3Target, SB3Block, SB3Project, isSB3Block,
  INPUT_SAME_BLOCK_SHADOW, INPUT_BLOCK_NO_SHADOW,
  MATH_NUM_PRIMITIVE, TEXT_PRIMITIVE,
} from '../types';
import { BlockBuilder } from '../blocks';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { uid, confusableName, randomInt, randomNumber, randomBool, pickRandom } from '../uid';

// ── Dead code context ────────────────────────────────────────────

export interface DeadCodeContext {
  fakeVars: { name: string; id: string }[];
  fakeLists: { name: string; id: string }[];
  fakeBroadcasts: { name: string; id: string }[];
  /** Variables with known initial values, never modified by any code — safe for predicates */
  anchorVars: { name: string; id: string; initValue: number }[];
}

// ── Standalone dead code injection ───────────────────────────────

export function applyDeadCode(project: SB3Project, config: ObfuscatorConfig, opts?: ObfuscateOptions): void {
  if (!config.deadCode.enabled) return;

  for (const target of project.targets) {
    if (!isTargetSelected(target, opts)) continue;
    applyDeadCodeToTarget(target, config);
  }
}

function isInsideProcedureDefinition(target: SB3Target, blockId: string): boolean {
  let current = blockId;
  for (let i = 0; i < 200; i++) {
    const block = target.blocks[current];
    if (!block || !isSB3Block(block)) return false;
    if (block.opcode === 'procedures_definition') return true;
    if (!block.parent) return false;
    current = block.parent;
  }
  return false;
}

/** CFF infrastructure blocks (receiver hats, cleanup hats) are placed at x:-9999, y:-9999. */
function isInsideCFFInfrastructure(target: SB3Target, blockId: string): boolean {
  let current = blockId;
  for (let i = 0; i < 200; i++) {
    const block = target.blocks[current];
    if (!block || !isSB3Block(block)) return false;
    if (block.topLevel) {
      return block.x === -9999 && block.y === -9999;
    }
    if (!block.parent) return false;
    current = block.parent;
  }
  return false;
}

function applyDeadCodeToTarget(target: SB3Target, config: ObfuscatorConfig): void {
  const bb = new BlockBuilder(target);

  // Build dead code context
  const ctx = ensureDeadCodeContext(target, bb);

  // Collect all non-primitive block IDs that have a "next"
  const blockIds = Object.keys(target.blocks).filter(id => {
    const block = target.blocks[id];
    return isSB3Block(block) && block.next && !block.topLevel;
  });

  for (const blockId of blockIds) {
    if (Math.random() > config.deadCode.probability) continue;

    const block = bb.getFullBlock(blockId);
    if (!block || !block.next) continue;

    // Skip blocks inside substacks of blocks we might have just created
    if (block.opcode.startsWith('!obf')) continue;

    // Skip blocks inside custom block definitions (CFF dispatcher infrastructure)
    if (isInsideProcedureDefinition(target, blockId)) continue;

    // Skip blocks inside CFF infrastructure (receiver hats, cleanup hats at -9999,-9999)
    if (isInsideCFFInfrastructure(target, blockId)) continue;

    const nextId = block.next;
    const nextBlock = bb.getFullBlock(nextId);
    const isIfElse = randomBool();

    // Build dead code substack
    const chainLen = randomInt(config.deadCode.minChainLength, config.deadCode.maxChainLength);
    let deadChain: string[];
    if (config.deadCode.builtinTemplates && randomBool()) {
      deadChain = generateBuiltinDeadCodeChain(bb, target, ctx, chainLen);
    } else {
      deadChain = generateDeadCodeChain(bb, target, ctx, chainLen);
    }

    // Chain dead code blocks together
    for (let i = 0; i < deadChain.length - 1; i++) {
      bb.setNext(deadChain[i], deadChain[i + 1]);
      bb.setParent(deadChain[i + 1], deadChain[i]);
    }

    const deadFirst = deadChain.length > 0 ? deadChain[0] : null;
    let ifBlockId: string;

    if (isIfElse) {
      // if-else: one branch holds real code, the other holds dead code.
      // alwaysTrue determines which branch is which.
      const alwaysTrue = randomBool();

      const elseChainLen = randomInt(config.deadCode.minChainLength, config.deadCode.maxChainLength);
      const elseChain = generateDeadCodeChain(bb, target, ctx, elseChainLen);
      for (let i = 0; i < elseChain.length - 1; i++) {
        bb.setNext(elseChain[i], elseChain[i + 1]);
        bb.setParent(elseChain[i + 1], elseChain[i]);
      }
      const elseFirst = elseChain.length > 0 ? elseChain[0] : null;

      // Condition created inside the branch where it's used — no orphaned blocks.
      const conditionId = pickCondition(bb, target, ctx, config, alwaysTrue);

      if (alwaysTrue) {
        // Always-true: real code in SUBSTACK, dead in SUBSTACK2
        ifBlockId = bb.controlIfElse(conditionId, nextId, elseFirst, null, blockId);
      } else {
        // Always-false: dead in SUBSTACK, real code in SUBSTACK2
        ifBlockId = bb.controlIfElse(conditionId, deadFirst, nextId, null, blockId);
      }

      bb.setParent(conditionId, ifBlockId);
      if (nextBlock) bb.setParent(nextId, ifBlockId);
      if (deadFirst) bb.setParent(deadFirst, ifBlockId);
      if (elseFirst) bb.setParent(elseFirst, ifBlockId);
    } else {
      // Simple if: always-false condition wraps dead code in SUBSTACK (unreachable).
      // Real code continues as the sequential next of the if block.
      const conditionId = pickCondition(bb, target, ctx, config, false);

      ifBlockId = bb.controlIf(conditionId, deadFirst, nextId, blockId);
      bb.setParent(conditionId, ifBlockId);
      if (deadFirst) bb.setParent(deadFirst, ifBlockId);
      if (nextBlock) bb.setParent(nextId, ifBlockId);
    }

    block.next = ifBlockId;
    bb.setParent(ifBlockId, blockId);
  }
}

// ── Dead code chain generators ───────────────────────────────────

/**
 * Generate a chain of generic dead code blocks (set variable, change variable,
 * add to list, broadcast, etc.)
 */
export function generateDeadCodeChain(
  bb: BlockBuilder,
  target: SB3Target,
  ctx: DeadCodeContext,
  length: number,
): string[] {
  const chain: string[] = [];
  for (let i = 0; i < length; i++) {
    const blockId = generateSingleDeadBlock(bb, target, ctx);
    if (blockId) chain.push(blockId);
  }
  return chain;
}

/**
 * Generate a chain of dynamic dead code blocks that use opaque predicates
 * and reference runtime values
 */
export function generateDynamicDeadCodeChain(
  bb: BlockBuilder,
  target: SB3Target,
  ctx: DeadCodeContext,
  length: number,
): string[] {
  const chain: string[] = [];
  for (let i = 0; i < length; i++) {
    const blockId = generateDynamicDeadBlock(bb, target, ctx);
    if (blockId) chain.push(blockId);
  }
  return chain;
}

/**
 * Generate a chain of builtin template dead code (more sophisticated patterns)
 */
export function generateBuiltinDeadCodeChain(
  bb: BlockBuilder,
  target: SB3Target,
  ctx: DeadCodeContext,
  length: number,
): string[] {
  const chain: string[] = [];
  // Pick a template and generate its blocks
  const template = pickRandom(...DEAD_CODE_TEMPLATES);
  const blocks = template(bb, target, ctx, length);
  chain.push(...blocks);
  return chain;
}

// ── Single dead block generators ─────────────────────────────────

function generateSingleDeadBlock(
  bb: BlockBuilder,
  target: SB3Target,
  ctx: DeadCodeContext,
): string | null {
  const kind = randomInt(1, 7);

  switch (kind) {
    case 1: {
      // Set a fake variable to a random value
      const fv = pickRandom(...ctx.fakeVars);
      if (!fv) return null;
      const value = randomBool()
        ? String(randomNumber(-10000, 10000))
        : uid(randomInt(5, 20));
      return bb.setVariable(fv.name, fv.id, randomBool() ? randomInt(-999, 999) : value);
    }
    case 2: {
      // Change a fake variable by a random amount
      const fv = pickRandom(...ctx.fakeVars);
      if (!fv) return null;
      return bb.changeVariable(fv.name, fv.id, randomInt(-100, 100));
    }
    case 3: {
      // Add to a fake list
      const fl = pickRandom(...ctx.fakeLists);
      if (!fl) return null;
      const itemId = randomBool()
        ? bb.numberLiteral(randomInt(-1000, 1000))
        : bb.textLiteral(uid(randomInt(5, 15)));
      return bb.addToList(fl.name, fl.id, itemId);
    }
    case 4: {
      // Delete all of a fake list
      const fl = pickRandom(...ctx.fakeLists);
      if (!fl) return null;
      return bb.deleteAllOfList(fl.name, fl.id);
    }
    case 5: {
      // Broadcast a fake broadcast
      const fb = pickRandom(...ctx.fakeBroadcasts);
      if (!fb) return null;
      return bb.broadcast(fb.name, fb.id);
    }
    case 6: {
      // control_incr_counter or control_clear_counter (obscure blocks)
      const opcode = randomBool() ? 'control_incr_counter' : 'control_clear_counter';
      return bb.createBlock({ opcode });
    }
    case 7: {
      // Replace item of a fake list
      const fl = pickRandom(...ctx.fakeLists);
      if (!fl) return null;
      const indexId = bb.numberLiteral(randomInt(1, 10));
      const itemId = bb.numberLiteral(randomInt(-999, 999));
      return bb.replaceItemOfList(fl.name, fl.id, indexId, itemId);
    }
    default:
      return null;
  }
}

function generateDynamicDeadBlock(
  bb: BlockBuilder,
  target: SB3Target,
  ctx: DeadCodeContext,
): string | null {
  // Dynamic dead code uses runtime values but in a way that's provably dead
  const kind = randomInt(1, 4);

  switch (kind) {
    case 1: {
      // Set variable to a math expression involving other fake vars
      const fv = pickRandom(...ctx.fakeVars);
      const fv2 = pickRandom(...ctx.fakeVars);
      if (!fv || !fv2) return null;
      // variable = fv2 * random + random
      const readFv2 = bb.readVariable(fv2.name, fv2.id);
      const mult = bb.mathOp('operator_multiply', readFv2, randomInt(2, 50));
      const add = bb.mathOp('operator_add', mult, randomInt(-100, 100));
      return bb.setVariableToBlock(fv.name, fv.id, add);
    }
    case 2: {
      // Add (fakeVar + random) to a fake list
      const fl = pickRandom(...ctx.fakeLists);
      const fv = pickRandom(...ctx.fakeVars);
      if (!fl || !fv) return null;
      const readFv = bb.readVariable(fv.name, fv.id);
      const expr = bb.mathOp('operator_add', readFv, randomInt(-50, 50));
      return bb.addToList(fl.name, fl.id, expr);
    }
    case 3: {
      // Replace list item at (random position) with (fakeVar mod random)
      const fl = pickRandom(...ctx.fakeLists);
      const fv = pickRandom(...ctx.fakeVars);
      if (!fl || !fv) return null;
      const readFv = bb.readVariable(fv.name, fv.id);
      const modExpr = bb.mathOp('operator_mod', readFv, randomInt(2, 20));
      const indexId = bb.numberLiteral(randomInt(1, 5));
      return bb.replaceItemOfList(fl.name, fl.id, indexId, modExpr);
    }
    case 4: {
      // Change variable by (fakeVar2 - constant)
      const fv = pickRandom(...ctx.fakeVars);
      const fv2 = pickRandom(...ctx.fakeVars);
      if (!fv || !fv2) return null;
      const readFv2 = bb.readVariable(fv2.name, fv2.id);
      const sub = bb.mathOp('operator_subtract', readFv2, randomInt(1, 100));
      return bb.setVariableToBlock(fv.name, fv.id, sub);
    }
    default:
      return null;
  }
}

/** Pick a condition generator based on config, with random selection between available types */
function pickCondition(
  bb: BlockBuilder, target: SB3Target, ctx: DeadCodeContext,
  config: ObfuscatorConfig, alwaysTrue: boolean,
): string {
  const candidates: (() => string | null)[] = [
    () => createStaticCondition(bb, alwaysTrue),
  ];
  if (config.deadCode.dynamicDeadCode) {
    candidates.push(() => createDynamicOpaqueCondition(bb, target, alwaysTrue));
  }
  if (config.deadCode.variableBasedPredicates && ctx.anchorVars.length > 0) {
    candidates.push(() => createVariableBasedCondition(bb, ctx, alwaysTrue));
  }
  // Try random candidate, fall back to static if it returns null
  const chosen = pickRandom(...candidates);
  return chosen() ?? createStaticCondition(bb, alwaysTrue);
}

// ── Opaque predicate generators ──────────────────────────────────

/**
 * Create a static condition that is always true or always false.
 *
 * Scratch's comparison semantics (Cast.compare):
 *   - If both values parse as numbers → numeric comparison
 *   - Otherwise → case-insensitive string comparison
 *
 * A non-numeric string starting with a letter (ASCII 65–122) is always
 * lexicographically GREATER than any number's string representation
 * ('-', '0'–'9' are all ASCII < 65).  Therefore:
 *   operator_lt(letter-string, number) = FALSE  (always)
 *   operator_gt(letter-string, number) = TRUE   (always)
 *
 * We prefix with 'l' to guarantee the first character is a letter,
 * making the string guaranteed non-numeric so string comparison triggers.
 */
function createStaticCondition(bb: BlockBuilder, alwaysTrue: boolean): string {
  // Prefix 'l' guarantees: non-numeric + letter-first → string comparison
  // → operator_lt(str, num) is always FALSE
  const str = bb.textLiteral('l' + uid(randomInt(4, 19)));
  const num = bb.numberLiteral(randomNumber(-1000000, 1000000));

  if (alwaysTrue) {
    // operator_gt(letter-string, number) is always TRUE
    return bb.comparison('operator_gt', str, num);
  } else {
    // operator_lt(letter-string, number) is always FALSE
    return bb.comparison('operator_lt', str, num);
  }
}

/**
 * Create a dynamic opaque predicate that evaluates at runtime.
 * These are conditions that are mathematically always true/false
 * but require evaluating an expression.
 */
function createDynamicOpaqueCondition(bb: BlockBuilder, target: SB3Target, alwaysTrue: boolean): string {
  const kind = randomInt(1, 4);

  switch (kind) {
    case 1: {
      // x * x > -1 is always true (since x*x >= 0 for any x)
      const x = randomInt(-1000, 1000);
      const xLit = bb.numberLiteral(x);
      const squared = bb.mathOp('operator_multiply', xLit, x);
      const negOne = bb.numberLiteral(-1);
      const gt = bb.comparison('operator_gt', squared, negOne);
      return alwaysTrue ? gt : bb.not(gt);
    }
    case 2: {
      // (a + b) = (b + a) is always true (commutativity)
      const a = randomInt(1, 1000);
      const b = randomInt(1, 1000);
      const sum1 = bb.mathOp('operator_add', a, b);
      const sum2 = bb.mathOp('operator_add', b, a);
      const eq = bb.comparison('operator_equals', sum1, sum2);
      return alwaysTrue ? eq : bb.not(eq);
    }
    case 3: {
      // abs(x) >= 0 is always true. Scratch has no abs, but we use:
      // ((x * x) > -1) which is always true since x*x >= 0
      const x = randomInt(-500, 500);
      const xLit1 = bb.numberLiteral(x);
      const xLit2 = bb.numberLiteral(x);
      const mul = bb.mathOp('operator_multiply', xLit1, xLit2);
      const negOne = bb.numberLiteral(-1);
      const gt = bb.comparison('operator_gt', mul, negOne);
      return alwaysTrue ? gt : bb.not(gt);
    }
    case 4: {
      // (n mod 2) < 2 is always true
      const n = randomInt(-1000, 1000);
      const nLit = bb.numberLiteral(n);
      const two1 = bb.numberLiteral(2);
      const mod = bb.mathOp('operator_mod', nLit, two1);
      const two2 = bb.numberLiteral(2);
      const lt = bb.comparison('operator_lt', mod, two2);
      return alwaysTrue ? lt : bb.not(lt);
    }
    default:
      return createStaticCondition(bb, alwaysTrue);
  }
}

/**
 * Create a variable-based opaque predicate using anchor variables.
 * Anchor vars have known init values and are NEVER modified, so these
 * predicates look runtime-dependent but are provably always true/false.
 */
function createVariableBasedCondition(
  bb: BlockBuilder, ctx: DeadCodeContext, alwaysTrue: boolean,
): string | null {
  if (ctx.anchorVars.length === 0) return null;

  const kind = randomInt(1, 5);
  switch (kind) {
    case 1: {
      // anchorVar == initValue → always true
      const av = pickRandom(...ctx.anchorVars);
      const readVar = bb.readVariable(av.name, av.id);
      const litVal = bb.numberLiteral(av.initValue);
      const eq = bb.comparison('operator_equals', readVar, litVal);
      return alwaysTrue ? eq : bb.not(eq);
    }
    case 2: {
      // anchorVar > (initValue + K) → always false (K > 0)
      const av = pickRandom(...ctx.anchorVars);
      const readVar = bb.readVariable(av.name, av.id);
      const litVal = bb.numberLiteral(av.initValue + randomInt(1, 10000));
      const gt = bb.comparison('operator_gt', readVar, litVal);
      // gt is always false
      return alwaysTrue ? bb.not(gt) : gt;
    }
    case 3: {
      // anchorVar1 + anchorVar2 == initValue1 + initValue2 → always true
      const av1 = pickRandom(...ctx.anchorVars);
      const av2 = pickRandom(...ctx.anchorVars);
      const read1 = bb.readVariable(av1.name, av1.id);
      const read2 = bb.readVariable(av2.name, av2.id);
      const sum = bb.mathOp('operator_add', read1, read2);
      const expectedLit = bb.numberLiteral(av1.initValue + av2.initValue);
      const eq = bb.comparison('operator_equals', sum, expectedLit);
      return alwaysTrue ? eq : bb.not(eq);
    }
    case 4: {
      // anchorVar * 2 < initValue * 2 + 1 → always true (since var == initValue)
      const av = pickRandom(...ctx.anchorVars);
      const readVar = bb.readVariable(av.name, av.id);
      const doubled = bb.mathOp('operator_multiply', readVar, 2);
      const bound = bb.numberLiteral(av.initValue * 2 + 1);
      const lt = bb.comparison('operator_lt', doubled, bound);
      return alwaysTrue ? lt : bb.not(lt);
    }
    case 5: {
      // anchorVar - initValue == 0 → always true
      const av = pickRandom(...ctx.anchorVars);
      const readVar = bb.readVariable(av.name, av.id);
      const sub = bb.mathOp('operator_subtract', readVar, av.initValue);
      const zeroLit = bb.numberLiteral(0);
      const eq = bb.comparison('operator_equals', sub, zeroLit);
      return alwaysTrue ? eq : bb.not(eq);
    }
    default:
      return null;
  }
}

// ── Builtin dead code templates ──────────────────────────────────
// These generate multi-block sequences that look like real code patterns

type DeadCodeTemplate = (
  bb: BlockBuilder,
  target: SB3Target,
  ctx: DeadCodeContext,
  length: number,
) => string[];

const DEAD_CODE_TEMPLATES: DeadCodeTemplate[] = [
  // Template 1: "Counter loop" - set var, increment in sequence
  (bb, target, ctx, length) => {
    const fv = pickRandom(...ctx.fakeVars);
    if (!fv) return [];
    const blocks: string[] = [];
    blocks.push(bb.setVariable(fv.name, fv.id, 0));
    for (let i = 1; i < length; i++) {
      blocks.push(bb.changeVariable(fv.name, fv.id, randomInt(1, 10)));
    }
    return blocks;
  },

  // Template 2: "List builder" - clear list then add items
  (bb, target, ctx, length) => {
    const fl = pickRandom(...ctx.fakeLists);
    if (!fl) return [];
    const blocks: string[] = [];
    blocks.push(bb.deleteAllOfList(fl.name, fl.id));
    for (let i = 1; i < length; i++) {
      const itemId = randomBool()
        ? bb.numberLiteral(randomInt(-999, 999))
        : bb.textLiteral(uid(randomInt(3, 10)));
      blocks.push(bb.addToList(fl.name, fl.id, itemId));
    }
    return blocks;
  },

  // Template 3: "State machine fragment" - set variable to different values
  (bb, target, ctx, length) => {
    const fv = pickRandom(...ctx.fakeVars);
    const fv2 = ctx.fakeVars.length > 1
      ? ctx.fakeVars.find(v => v.id !== fv?.id) || fv
      : fv;
    if (!fv || !fv2) return [];
    const blocks: string[] = [];
    for (let i = 0; i < length; i++) {
      if (randomBool()) {
        blocks.push(bb.setVariable(fv.name, fv.id, randomInt(1, 100)));
      } else {
        blocks.push(bb.setVariable(fv2.name, fv2.id, randomInt(1, 100)));
      }
    }
    return blocks;
  },

  // Template 4: "Accumulator" - read var, compute, write back
  (bb, target, ctx, length) => {
    const fv = pickRandom(...ctx.fakeVars);
    const fv2 = pickRandom(...ctx.fakeVars);
    if (!fv || !fv2) return [];
    const blocks: string[] = [];
    for (let i = 0; i < length; i++) {
      const readId = bb.readVariable(fv2.name, fv2.id);
      const op = pickRandom('operator_add', 'operator_subtract', 'operator_multiply');
      const expr = bb.mathOp(op, readId, randomInt(1, 50));
      blocks.push(bb.setVariableToBlock(fv.name, fv.id, expr));
    }
    return blocks;
  },

  // Template 5: "Broadcast sequence" - fire a sequence of fake broadcasts
  (bb, target, ctx, length) => {
    const blocks: string[] = [];
    for (let i = 0; i < Math.min(length, ctx.fakeBroadcasts.length); i++) {
      const fb = ctx.fakeBroadcasts[i % ctx.fakeBroadcasts.length];
      blocks.push(bb.broadcast(fb.name, fb.id));
    }
    return blocks;
  },

  // Template 6: "List swap" - read items and replace in reverse
  (bb, target, ctx, length) => {
    const fl = pickRandom(...ctx.fakeLists);
    if (!fl) return [];
    const blocks: string[] = [];
    for (let i = 0; i < length; i++) {
      const idx = bb.numberLiteral(randomInt(1, 10));
      const val = bb.numberLiteral(randomInt(-999, 999));
      blocks.push(bb.replaceItemOfList(fl.name, fl.id, idx, val));
    }
    return blocks;
  },
];

// ── Ensure dead code context ─────────────────────────────────────

function ensureDeadCodeContext(target: SB3Target, bb: BlockBuilder): DeadCodeContext {
  const fakeVars: { name: string; id: string }[] = [];
  const fakeLists: { name: string; id: string }[] = [];
  const fakeBroadcasts: { name: string; id: string }[] = [];

  // Create fake variables
  for (let i = 0; i < 5; i++) {
    const name = confusableName();
    const id = bb.createVariable(name, randomInt(-9999, 9999));
    fakeVars.push({ name, id });
  }

  // Create fake lists
  for (let i = 0; i < 3; i++) {
    const name = confusableName();
    const items: number[] = [];
    for (let j = 0; j < randomInt(3, 10); j++) items.push(randomInt(-100, 100));
    const id = bb.createList(name, items);
    fakeLists.push({ name, id });
  }

  // Create fake broadcasts
  for (let i = 0; i < 3; i++) {
    const name = confusableName();
    const id = bb.createBroadcast(name);
    fakeBroadcasts.push({ name, id });
  }

  // Create anchor variables (known init values, never modified — used for predicates)
  const anchorVars: { name: string; id: string; initValue: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const name = confusableName();
    const initValue = randomInt(-9999, 9999);
    const id = bb.createVariable(name, initValue);
    anchorVars.push({ name, id, initValue });
  }

  return { fakeVars, fakeLists, fakeBroadcasts, anchorVars };
}
