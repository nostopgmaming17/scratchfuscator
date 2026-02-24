/**
 * Anti-Tamper Transform
 *
 * Injects integrity checks that detect if the project has been modified
 * (variables renamed, sprites renamed, etc.) and halts execution if so.
 *
 * Runs LAST in the pipeline (after all other transforms) so it knows
 * the final obfuscated names and values.
 *
 * Check types:
 *   A. Sentinel value checks — magic-value variables verified in forever loops
 *   B. Self sensing_of (static) — sprite verifies its own vars via sensing_of of itself
 *   C. Self sensing_of (dynamic) — own sprite name stored in a variable
 *   D. Tamper flag monitors — redundant forever loops watching shared flags
 *   E. List integrity checks — verify list length/contents haven't changed
 *   F. Variable cross-reference — two variables store each other's expected values
 *   G. Costume # check — sensing_of costume # of self to verify sprite name + costume
 *   H. Cross-sprite sensing_of — sprite checks another sprite's sentinel (distributed)
 *   I. Procedure integrity — custom block sets a variable; if proccode renamed, call fails
 *   J. Delayed checks — wait random duration before checking (harder to step through)
 *   K. Encoded flag system — flags combined via formula, can't just zero them out
 */

import {
  SB3Target, SB3Project,
  INPUT_SAME_BLOCK_SHADOW, INPUT_BLOCK_NO_SHADOW, INPUT_DIFF_BLOCK_SHADOW,
} from '../types';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { BlockBuilder } from '../blocks';
import { confusableName, randomInt } from '../uid';

interface TamperFlag {
  name: string;
  id: string;
}

interface Sentinel {
  name: string;
  id: string;
  magic: number;
}

// ── Helper: build a checker script ───────────────────────────────────

/**
 * Inject a green-flag script:
 *   when flag clicked
 *   forever
 *     if <not <validCondition>> then
 *       set [flag1] to 1 ... stop [all]
 *     end
 *   end
 *
 * @param validCondition - block ID of a boolean that's TRUE when everything is OK
 */
function injectCheckerScript(
  bb: BlockBuilder,
  validCondition: string,
  tamperFlags: TamperFlag[],
): void {
  const stopId = bb.createBlock({
    opcode: 'control_stop',
    fields: { STOP_OPTION: ['all', null] },
    mutation: { tagName: 'mutation', children: [], hasnext: 'false' },
  });

  const setIds: string[] = [];
  for (const flag of tamperFlags) {
    setIds.push(bb.setVariable(flag.name, flag.id, 1));
  }
  bb.chain(...setIds, stopId);
  const firstInBody = setIds.length > 0 ? setIds[0] : stopId;

  const notId = bb.not(validCondition);
  bb.setParent(validCondition, notId);

  const ifId = bb.controlIf(notId, firstInBody);
  bb.setParent(notId, ifId);
  bb.setParent(firstInBody, ifId);

  const foreverId = bb.forever(ifId);
  bb.setParent(ifId, foreverId);

  const hatId = bb.createBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true,
    x: randomInt(-2000, 2000),
    y: randomInt(-2000, 2000),
  });
  bb.chain(hatId, foreverId);
}

// ── Helper: build a sensing_of block ─────────────────────────────────

/**
 * Build a sensing_of block targeting a specific object with a given property.
 * @param objectName - the sprite name or "_stage_"
 * @param property - the PROPERTY field value (variable name, "costume #", etc.)
 * @param dynamic - if true, store objectName in a variable for the OBJECT input
 */
function buildSensingOf(
  bb: BlockBuilder,
  objectName: string,
  property: string,
  dynamic: boolean,
): string {
  const menuId = bb.createBlock({
    opcode: 'sensing_of_object_menu',
    fields: { OBJECT: [objectName, null] },
    shadow: true,
  });

  let sensingId: string;

  if (dynamic) {
    const nameVarName = confusableName(80);
    const nameVarId = bb.createVariable(nameVarName, objectName);
    const readNameId = bb.readVariable(nameVarName, nameVarId);

    sensingId = bb.createBlock({
      opcode: 'sensing_of',
      fields: { PROPERTY: [property, null] },
      inputs: { OBJECT: [INPUT_DIFF_BLOCK_SHADOW, readNameId, menuId] },
    });
    bb.setParent(readNameId, sensingId);
  } else {
    sensingId = bb.createBlock({
      opcode: 'sensing_of',
      fields: { PROPERTY: [property, null] },
      inputs: { OBJECT: [INPUT_SAME_BLOCK_SHADOW, menuId] },
    });
  }
  bb.setParent(menuId, sensingId);

  return sensingId;
}

/**
 * Get the sensing_of OBJECT name for a target.
 * Stage uses "_stage_", sprites use their name.
 */
function sensingObjectName(target: SB3Target): string {
  return target.isStage ? '_stage_' : target.name;
}

// ── Check type A: Sentinel value ─────────────────────────────────────

function injectSentinelCheck(
  bb: BlockBuilder,
  sentinel: Sentinel,
  tamperFlags: TamperFlag[],
): void {
  const readId = bb.readVariable(sentinel.name, sentinel.id);
  const magicId = bb.numberLiteral(sentinel.magic);
  const eqId = bb.comparison('operator_equals', readId, magicId);
  bb.setParent(readId, eqId);
  bb.setParent(magicId, eqId);

  injectCheckerScript(bb, eqId, tamperFlags);
}

// ── Check type B/C: Self sensing_of ──────────────────────────────────

/**
 * A sprite/stage verifies its own sentinel variable via sensing_of of itself.
 * This checks both that the variable name is intact AND that the
 * sprite/stage name is intact (sensing_of fails if either is renamed).
 */
function injectSelfSensingCheck(
  bb: BlockBuilder,
  target: SB3Target,
  sentinel: Sentinel,
  tamperFlags: TamperFlag[],
  dynamic: boolean,
): void {
  const objName = sensingObjectName(target);
  const sensingId = buildSensingOf(bb, objName, sentinel.name, dynamic);

  const magicId = bb.numberLiteral(sentinel.magic);
  const eqId = bb.comparison('operator_equals', sensingId, magicId);
  bb.setParent(sensingId, eqId);
  bb.setParent(magicId, eqId);

  injectCheckerScript(bb, eqId, tamperFlags);
}

// ── Check type D: Tamper flag monitor ────────────────────────────────

function injectFlagMonitor(
  bb: BlockBuilder,
  tamperFlags: TamperFlag[],
): void {
  if (tamperFlags.length === 0) return;

  const eqIds: string[] = [];
  for (const flag of tamperFlags) {
    const readId = bb.readVariable(flag.name, flag.id);
    const zeroId = bb.numberLiteral(0);
    const eqId = bb.comparison('operator_equals', readId, zeroId);
    bb.setParent(readId, eqId);
    bb.setParent(zeroId, eqId);
    eqIds.push(eqId);
  }

  let condition = eqIds[0];
  for (let i = 1; i < eqIds.length; i++) {
    const andId = bb.and(condition, eqIds[i]);
    bb.setParent(condition, andId);
    bb.setParent(eqIds[i], andId);
    condition = andId;
  }

  // Monitor only does stop all (flags are already set by whatever tripped them)
  const stopId = bb.createBlock({
    opcode: 'control_stop',
    fields: { STOP_OPTION: ['all', null] },
    mutation: { tagName: 'mutation', children: [], hasnext: 'false' },
  });

  const notId = bb.not(condition);
  bb.setParent(condition, notId);

  const ifId = bb.controlIf(notId, stopId);
  bb.setParent(notId, ifId);
  bb.setParent(stopId, ifId);

  const foreverId = bb.forever(ifId);
  bb.setParent(ifId, foreverId);

  const hatId = bb.createBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true,
    x: randomInt(-2000, 2000),
    y: randomInt(-2000, 2000),
  });
  bb.chain(hatId, foreverId);
}

// ── Check type E: List integrity ─────────────────────────────────────

function injectListIntegrityCheck(
  bb: BlockBuilder,
  tamperFlags: TamperFlag[],
): void {
  const listName = confusableName(80);
  const itemCount = randomInt(3, 8);
  const items: number[] = [];
  for (let i = 0; i < itemCount; i++) {
    items.push(randomInt(1000, 99999));
  }
  const listId = bb.createList(listName, items);

  const checkIdx = randomInt(0, itemCount - 1);
  const expectedValue = items[checkIdx];

  const lengthId = bb.lengthOfList(listName, listId);
  const expectedLenId = bb.numberLiteral(itemCount);
  const lenEqId = bb.comparison('operator_equals', lengthId, expectedLenId);
  bb.setParent(lengthId, lenEqId);
  bb.setParent(expectedLenId, lenEqId);

  const idxId = bb.numberLiteral(checkIdx + 1); // 1-based
  const itemId = bb.itemOfList(listName, listId, idxId);
  bb.setParent(idxId, itemId);
  const expectedValId = bb.numberLiteral(expectedValue);
  const valEqId = bb.comparison('operator_equals', itemId, expectedValId);
  bb.setParent(itemId, valEqId);
  bb.setParent(expectedValId, valEqId);

  const andId = bb.and(lenEqId, valEqId);
  bb.setParent(lenEqId, andId);
  bb.setParent(valEqId, andId);

  injectCheckerScript(bb, andId, tamperFlags);
}

// ── Check type F: Variable cross-reference ───────────────────────────

function injectCrossRefCheck(
  bb: BlockBuilder,
  tamperFlags: TamperFlag[],
): void {
  const magic1 = randomInt(10000, 99999);
  const magic2 = randomInt(10000, 99999);

  const name1 = confusableName(80);
  const name2 = confusableName(80);
  const id1 = bb.createVariable(name1, magic2);
  const id2 = bb.createVariable(name2, magic1);

  const read1 = bb.readVariable(name1, id1);
  const lit2 = bb.numberLiteral(magic2);
  const eq1 = bb.comparison('operator_equals', read1, lit2);
  bb.setParent(read1, eq1);
  bb.setParent(lit2, eq1);

  const read2 = bb.readVariable(name2, id2);
  const lit1 = bb.numberLiteral(magic1);
  const eq2 = bb.comparison('operator_equals', read2, lit1);
  bb.setParent(read2, eq2);
  bb.setParent(lit1, eq2);

  const andId = bb.and(eq1, eq2);
  bb.setParent(eq1, andId);
  bb.setParent(eq2, andId);

  injectCheckerScript(bb, andId, tamperFlags);
}

// ── Check type G: Costume # check via sensing_of ─────────────────────

/**
 * Verify costume # via sensing_of of self.
 * Checks: sensing_of [costume #] of [self] = expected costume number
 * Detects: sprite rename (sensing_of target changes), costume reorder
 */
function injectCostumeNumCheck(
  bb: BlockBuilder,
  target: SB3Target,
  tamperFlags: TamperFlag[],
): void {
  const expectedCostumeNum = target.currentCostume + 1; // Scratch is 1-based
  const objName = sensingObjectName(target);

  const sensingId = buildSensingOf(bb, objName, 'costume #', false);

  const expectedId = bb.numberLiteral(expectedCostumeNum);
  const eqId = bb.comparison('operator_equals', sensingId, expectedId);
  bb.setParent(sensingId, eqId);
  bb.setParent(expectedId, eqId);

  injectCheckerScript(bb, eqId, tamperFlags);
}

// ── Check type H: Cross-sprite sensing_of (distributed) ─────────────

/**
 * One sprite checks another sprite's sentinel variable via sensing_of.
 * Distributed across sprites instead of all on stage.
 * @param dynamic - if true, store the other sprite's name in a variable
 */
function injectCrossSpriteSensingCheck(
  bb: BlockBuilder,
  otherSpriteName: string,
  sentinel: Sentinel,
  tamperFlags: TamperFlag[],
  dynamic: boolean,
): void {
  const sensingId = buildSensingOf(bb, otherSpriteName, sentinel.name, dynamic);

  const magicId = bb.numberLiteral(sentinel.magic);
  const eqId = bb.comparison('operator_equals', sensingId, magicId);
  bb.setParent(sensingId, eqId);
  bb.setParent(magicId, eqId);

  injectCheckerScript(bb, eqId, tamperFlags);
}

// ── Check type I: Procedure integrity ─────────────────────────────────

/**
 * Define a custom block that sets a verification variable to a magic value.
 * Call it on green flag, then check the variable.
 * If someone renames the procedure, the call won't match the definition
 * and the variable stays at 0 → detected.
 *
 *   define [obfuscatedName]
 *     set [verifyVar] to [magic]
 *
 *   when flag clicked
 *     set [verifyVar] to 0
 *     call [obfuscatedName]
 *     forever
 *       if <not <(verifyVar) = (magic)>> then
 *         set flags, stop all
 *       end
 *     end
 */
function injectProcedureIntegrityCheck(
  bb: BlockBuilder,
  tamperFlags: TamperFlag[],
): void {
  const magic = randomInt(10000, 99999);
  const procName = confusableName(50);
  const proccode = procName;
  const verifyVarName = confusableName(80);
  const verifyVarId = bb.createVariable(verifyVarName, 0);

  // Define the custom block: body sets verifyVar to magic
  const setMagicId = bb.setVariable(verifyVarName, verifyVarId, magic);
  const { definitionId } = bb.procedureDefinition(
    proccode, [], [], true, setMagicId,
  );
  bb.setParent(setMagicId, definitionId);

  // Build the checker condition: verifyVar = magic
  const readId = bb.readVariable(verifyVarName, verifyVarId);
  const magicId = bb.numberLiteral(magic);
  const eqId = bb.comparison('operator_equals', readId, magicId);
  bb.setParent(readId, eqId);
  bb.setParent(magicId, eqId);

  // Build: stop all + set flags
  const stopId = bb.createBlock({
    opcode: 'control_stop',
    fields: { STOP_OPTION: ['all', null] },
    mutation: { tagName: 'mutation', children: [], hasnext: 'false' },
  });
  const setIds: string[] = [];
  for (const flag of tamperFlags) {
    setIds.push(bb.setVariable(flag.name, flag.id, 1));
  }
  bb.chain(...setIds, stopId);
  const firstInBody = setIds.length > 0 ? setIds[0] : stopId;

  const notId = bb.not(eqId);
  bb.setParent(eqId, notId);
  const ifId = bb.controlIf(notId, firstInBody);
  bb.setParent(notId, ifId);
  bb.setParent(firstInBody, ifId);
  const foreverId = bb.forever(ifId);
  bb.setParent(ifId, foreverId);

  // Green flag script: set verifyVar to 0 → call proc → forever check
  const resetId = bb.setVariable(verifyVarName, verifyVarId, 0);
  const callId = bb.procedureCall(proccode, [], [], true);
  bb.chain(resetId, callId, foreverId);

  const hatId = bb.createBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true,
    x: randomInt(-2000, 2000),
    y: randomInt(-2000, 2000),
  });
  bb.chain(hatId, resetId);
}

// ── Check type J: Delayed check ──────────────────────────────────────

/**
 * Like injectCheckerScript but waits a random duration (0.5–3s) before
 * starting the forever check loop. Makes it harder to find by stepping
 * through execution since it fires at unpredictable times.
 */
function injectDelayedCheckerScript(
  bb: BlockBuilder,
  validCondition: string,
  tamperFlags: TamperFlag[],
  delaySecs: number,
): void {
  const stopId = bb.createBlock({
    opcode: 'control_stop',
    fields: { STOP_OPTION: ['all', null] },
    mutation: { tagName: 'mutation', children: [], hasnext: 'false' },
  });

  const setIds: string[] = [];
  for (const flag of tamperFlags) {
    setIds.push(bb.setVariable(flag.name, flag.id, 1));
  }
  bb.chain(...setIds, stopId);
  const firstInBody = setIds.length > 0 ? setIds[0] : stopId;

  const notId = bb.not(validCondition);
  bb.setParent(validCondition, notId);

  const ifId = bb.controlIf(notId, firstInBody);
  bb.setParent(notId, ifId);
  bb.setParent(firstInBody, ifId);

  const foreverId = bb.forever(ifId);
  bb.setParent(ifId, foreverId);

  // Wait block before the forever loop
  const delayLit = bb.numberLiteral(delaySecs);
  const waitId = bb.controlWait(delayLit);
  bb.setParent(delayLit, waitId);
  bb.chain(waitId, foreverId);

  const hatId = bb.createBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true,
    x: randomInt(-2000, 2000),
    y: randomInt(-2000, 2000),
  });
  bb.chain(hatId, waitId);
}

/**
 * Inject a delayed sentinel check — same as type A but with a random wait.
 */
function injectDelayedSentinelCheck(
  bb: BlockBuilder,
  sentinel: Sentinel,
  tamperFlags: TamperFlag[],
): void {
  const readId = bb.readVariable(sentinel.name, sentinel.id);
  const magicId = bb.numberLiteral(sentinel.magic);
  const eqId = bb.comparison('operator_equals', readId, magicId);
  bb.setParent(readId, eqId);
  bb.setParent(magicId, eqId);

  const delay = randomInt(1, 5); // 1–5 seconds
  injectDelayedCheckerScript(bb, eqId, tamperFlags, delay);
}

// ── Check type K: Encoded flag system ────────────────────────────────

/**
 * Instead of simple 0/1 tamper flags, create an encoded flag system where
 * three variables must satisfy: (v1 * v2 + v3) = expected.
 * A tamperer can't just set all flags to 0 — they'd need to solve the equation.
 *
 * Creates 3 key variables with values a, b, c where a*b + c = magic.
 * Monitors this in a forever loop.
 */
function injectEncodedFlagCheck(
  bb: BlockBuilder,
  tamperFlags: TamperFlag[],
): void {
  const a = randomInt(7, 50);
  const b = randomInt(7, 50);
  const c = randomInt(100, 999);
  const magic = a * b + c;

  const nameA = confusableName(80);
  const nameB = confusableName(80);
  const nameC = confusableName(80);
  const idA = bb.createVariable(nameA, a);
  const idB = bb.createVariable(nameB, b);
  const idC = bb.createVariable(nameC, c);

  // Build: (readA * readB) + readC = magic
  const readA = bb.readVariable(nameA, idA);
  const readB = bb.readVariable(nameB, idB);
  const mulId = bb.mathOp('operator_multiply', readA, readB);
  bb.setParent(readA, mulId);
  bb.setParent(readB, mulId);

  const readC = bb.readVariable(nameC, idC);
  const addId = bb.mathOp('operator_add', mulId, readC);
  bb.setParent(mulId, addId);
  bb.setParent(readC, addId);

  const magicLit = bb.numberLiteral(magic);
  const eqId = bb.comparison('operator_equals', addId, magicLit);
  bb.setParent(addId, eqId);
  bb.setParent(magicLit, eqId);

  injectCheckerScript(bb, eqId, tamperFlags);
}

// ── Check type L: String list checksum ────────────────────────────────

/**
 * Compute a checksum of the constants string pool by summing the length
 * of every item. Inject a green-flag script that recomputes the sum at
 * runtime and verifies it matches the expected value.
 *
 *   when flag clicked
 *   set [sum] to 0
 *   set [i] to 1
 *   repeat (length of [constList])
 *     change [sum] by (length of (item (i) of [constList]))
 *     change [i] by 1
 *   end
 *   forever
 *     if <not <(sum) = (expected)>> then
 *       set flags, stop all
 *     end
 *   end
 */
function injectStringListChecksumCheck(
  bb: BlockBuilder,
  listName: string,
  listId: string,
  expectedChecksum: number,
  tamperFlags: TamperFlag[],
): void {
  // Create counter and sum variables
  const sumVarName = confusableName(80);
  const sumVarId = bb.createVariable(sumVarName, 0);
  const iVarName = confusableName(80);
  const iVarId = bb.createVariable(iVarName, 0);

  // Inside repeat body: change [sum] by (length of (item (i) of [list]))
  // Then: change [i] by 1

  // item (i) of [list]
  const readI = bb.readVariable(iVarName, iVarId);
  const itemOfId = bb.itemOfList(listName, listId, readI);
  bb.setParent(readI, itemOfId);

  // length of (item)
  const lengthId = bb.createBlock({
    opcode: 'operator_length',
    inputs: { STRING: [INPUT_BLOCK_NO_SHADOW, itemOfId] },
  });
  bb.setParent(itemOfId, lengthId);

  // change [sum] by (length)
  // We need to use setVariableToBlock since changeVariable only takes a number literal
  // Actually, we can use createBlock for data_changevariableby with a block input
  const changeSumId = bb.createBlock({
    opcode: 'data_changevariableby',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, lengthId] },
    fields: { VARIABLE: [sumVarName, sumVarId] },
  });
  bb.setParent(lengthId, changeSumId);

  // change [i] by 1
  const changeIId = bb.changeVariable(iVarName, iVarId, 1);
  bb.chain(changeSumId, changeIId);

  // repeat (length of list) { body }
  const listLengthId = bb.lengthOfList(listName, listId);
  const repeatId = bb.controlRepeat(listLengthId, changeSumId);
  bb.setParent(listLengthId, repeatId);
  bb.setParent(changeSumId, repeatId);

  // Before the loop: set [sum] to 0, set [i] to 1
  const setSumId = bb.setVariable(sumVarName, sumVarId, 0);
  const setIId = bb.setVariable(iVarName, iVarId, 1);
  bb.chain(setSumId, setIId, repeatId);

  // After the loop: forever check sum = expected
  const readSum = bb.readVariable(sumVarName, sumVarId);
  const expectedLit = bb.numberLiteral(expectedChecksum);
  const eqId = bb.comparison('operator_equals', readSum, expectedLit);
  bb.setParent(readSum, eqId);
  bb.setParent(expectedLit, eqId);

  // Build the tamper response: set flags → stop all
  const stopId = bb.createBlock({
    opcode: 'control_stop',
    fields: { STOP_OPTION: ['all', null] },
    mutation: { tagName: 'mutation', children: [], hasnext: 'false' },
  });
  const setIds: string[] = [];
  for (const flag of tamperFlags) {
    setIds.push(bb.setVariable(flag.name, flag.id, 1));
  }
  bb.chain(...setIds, stopId);
  const firstInBody = setIds.length > 0 ? setIds[0] : stopId;

  const notId = bb.not(eqId);
  bb.setParent(eqId, notId);
  const ifId = bb.controlIf(notId, firstInBody);
  bb.setParent(notId, ifId);
  bb.setParent(firstInBody, ifId);
  const foreverId = bb.forever(ifId);
  bb.setParent(ifId, foreverId);

  bb.chain(repeatId, foreverId);

  // Hat
  const hatId = bb.createBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true,
    x: randomInt(-2000, 2000),
    y: randomInt(-2000, 2000),
  });
  bb.chain(hatId, setSumId);
}

// ── Main entry point ─────────────────────────────────────────────────

export function applyAntiTamper(
  project: SB3Project,
  config: ObfuscatorConfig,
  opts?: ObfuscateOptions,
): void {
  if (!config.antiTamper.enabled) return;

  const stage = project.targets.find(t => t.isStage);
  if (!stage) return;

  const sprites = project.targets.filter(
    t => !t.isStage && isTargetSelected(t, opts),
  );

  const stageBb = new BlockBuilder(stage);

  // ── Create tamper flag variables on stage (global) ──
  const tamperFlags: TamperFlag[] = [];
  for (let i = 0; i < 3; i++) {
    const name = confusableName(80);
    const id = stageBb.createVariable(name, 0);
    tamperFlags.push({ name, id });
  }

  // ── Create sentinel variables on each target ──
  const targetSentinels = new Map<SB3Target, Sentinel[]>();
  for (const target of [stage, ...sprites]) {
    const bb = new BlockBuilder(target);
    const sents: Sentinel[] = [];
    for (let i = 0; i < 2; i++) {
      const magic = randomInt(10000, 99999);
      const name = confusableName(80);
      const id = bb.createVariable(name, magic);
      sents.push({ name, id, magic });
    }
    targetSentinels.set(target, sents);
  }

  const at = config.antiTamper;

  // ── Inject per-target checks ──
  for (const target of [stage, ...sprites]) {
    const bb = new BlockBuilder(target);
    const sents = targetSentinels.get(target)!;

    // Type A: Hidden variable checks (direct variable read)
    if (at.hiddenVariableChecks) {
      for (const s of sents) {
        injectSentinelCheck(bb, s, tamperFlags);
      }
    }

    // Type B/C: Sensing_of self checks
    if (at.sensingOfSelfChecks) {
      injectSelfSensingCheck(bb, target, sents[0], tamperFlags, false);

      // Type C: Self sensing_of (dynamic) — own name in a variable
      if (sents.length > 1) {
        injectSelfSensingCheck(bb, target, sents[1], tamperFlags, true);
      }
    }

    // Type D: Tamper flag monitors
    if (at.tamperFlagMonitors) {
      injectFlagMonitor(bb, tamperFlags);
    }

    // Type E: Hidden list checks
    if (at.hiddenListChecks) {
      injectListIntegrityCheck(bb, tamperFlags);
    }

    // Type F: Paired variable checks
    if (at.pairedVariableChecks) {
      injectCrossRefCheck(bb, tamperFlags);
    }

    // Type G: Costume number checks
    if (at.costumeNumberChecks && target.costumes.length > 0) {
      injectCostumeNumCheck(bb, target, tamperFlags);
    }

    // Type I: Custom block integrity
    if (at.customBlockIntegrity) {
      injectProcedureIntegrityCheck(bb, tamperFlags);
    }

    // Type J: Delayed integrity checks
    if (at.delayedIntegrityChecks) {
      injectDelayedSentinelCheck(bb, sents[0], tamperFlags);
    }

    // Type K: Mathematical flag checks
    if (at.mathematicalFlagChecks) {
      injectEncodedFlagCheck(bb, tamperFlags);
    }
  }

  // ── Type L: String list checksum (on stage) ──
  if (at.stringListChecksum && project._constListInfo) {
    const { id: listId, name: listName } = project._constListInfo;
    const listData = stage.lists[listId];
    if (listData && listData[1].length > 0) {
      // Precompute the expected checksum: sum of string lengths
      let expectedChecksum = 0;
      for (const item of listData[1]) {
        expectedChecksum += String(item).length;
      }
      injectStringListChecksumCheck(
        stageBb, listName, listId, expectedChecksum, tamperFlags,
      );
    }
  }

  // ── Type H: Cross-sprite verification ──
  if (at.crossSpriteVerification) {
    // Each sprite checks the NEXT sprite in the list (circular).
    if (sprites.length >= 2) {
      for (let i = 0; i < sprites.length; i++) {
        const checker = sprites[i];
        const other = sprites[(i + 1) % sprites.length];
        const otherSents = targetSentinels.get(other);
        if (!otherSents || otherSents.length === 0) continue;

        const checkerBb = new BlockBuilder(checker);

        // Static cross-sprite check
        injectCrossSpriteSensingCheck(
          checkerBb, other.name, otherSents[0], tamperFlags, false,
        );

        // Dynamic cross-sprite check (name in variable)
        if (otherSents.length > 1) {
          injectCrossSpriteSensingCheck(
            checkerBb, other.name, otherSents[1], tamperFlags, true,
          );
        }
      }
    } else if (sprites.length === 1) {
      // Only one sprite — stage checks it, sprite checks stage
      const sprite = sprites[0];
      const spriteSents = targetSentinels.get(sprite)!;
      const stageSents = targetSentinels.get(stage)!;

      injectCrossSpriteSensingCheck(
        stageBb, sprite.name, spriteSents[0], tamperFlags, false,
      );

      const spriteBb = new BlockBuilder(sprite);
      injectCrossSpriteSensingCheck(
        spriteBb, '_stage_', stageSents[0], tamperFlags, true,
      );
    }
  }
}
