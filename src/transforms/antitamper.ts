/**
 * Anti-Tamper Transform
 *
 * Two-phase architecture:
 *   Phase 1 (prepareAntiTamper): Creates sentinel variables, tamper flags, and
 *     stores them on project._antiTamperContext. No scripts are created.
 *   Phase 2 (during CFF): generateTamperCheckStates() produces CFGState branch
 *     states that get spliced into existing CFF state machines — interleaved with
 *     real logic so they're indistinguishable from normal states.
 *
 * Standalone scripts (applyAntiTamper) are kept only for type D (tamper flag
 * monitors) which need their own forever-loop green-flag scripts.
 *
 * Check types merged into CFF state machines:
 *   A. Sentinel value checks — magic-value variables verified as branch states
 *   B/C. Self sensing_of (static/dynamic) — sprite verifies own vars via sensing_of
 *   E. List integrity checks — verify list length/contents
 *   F. Variable cross-reference — two variables store each other's expected values
 *   H. Cross-sprite sensing_of — sprite checks another sprite's sentinel
 *   K. Encoded flag system — flags combined via formula
 *
 * Standalone (separate green-flag scripts, CFF'd normally):
 *   D. Tamper flag monitors — redundant forever loops watching shared flags
 *
 * Separate late-phase:
 *   L. String list checksum — runs after constants pass
 */

import {
  SB3Target, SB3Project,
  INPUT_SAME_BLOCK_SHADOW, INPUT_BLOCK_NO_SHADOW, INPUT_DIFF_BLOCK_SHADOW,
} from '../types';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { BlockBuilder } from '../blocks';
import { confusableName, randomInt } from '../uid';

// ── Public types ──────────────────────────────────────────────────

export interface TamperFlag {
  name: string;
  id: string;
}

export interface Sentinel {
  name: string;
  id: string;
  magic: number;
}

export interface AntiTamperContext {
  tamperFlags: TamperFlag[];
  targetSentinels: Map<SB3Target, Sentinel[]>;
  config: ObfuscatorConfig['antiTamper'];
}

/**
 * Result from generateTamperCheckStates: new states to add, plus a redirect
 * map telling the caller which existing state transitions to reroute through
 * tamper check branch states.
 */
export interface TamperCheckResult {
  /** New CFGState objects to add to the state machine */
  states: TamperCFGState[];
  /**
   * Maps existingStatePc → tamperBranchPc.
   * The caller should find states whose nextPc (or branch truePc/falsePc)
   * equals the key and rewrite them to point to the tamperBranchPc instead.
   * Actually: we pick random linear states and redirect THEIR nextPc through
   * the check. So the map is: originalNextPc → branchPc, and the branch's
   * truePc = originalNextPc (continuation).
   */
  redirects: Map<number/*targetStatePc*/, number/*branchPc*/>;
}

/** Minimal CFGState shape — matches the CFF module's CFGState interface */
export interface TamperCFGState {
  pc: number;
  bodyBlockIds: string[];
  nextPc: number;
  branch?: {
    conditionBlockId: string;
    truePc: number;
    falsePc: number;
  };
  isTerminal?: boolean;
  isDead: boolean;
}

// ── Helper: build a sensing_of block ─────────────────────────────

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

function sensingObjectName(target: SB3Target): string {
  return target.isStage ? '_stage_' : target.name;
}

// ── Helper: build a green-flag checker script (for standalone types) ──

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

// ── Check type D: Tamper flag monitor (standalone) ───────────────

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

// ── Phase 1: Prepare anti-tamper context ─────────────────────────

/**
 * Creates sentinel variables and tamper flags on each target.
 * Stores the context on project._antiTamperContext for CFF to consume.
 * Does NOT create any scripts — those are generated as CFF states.
 */
export function prepareAntiTamper(
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

  // Create tamper flag variables on stage (global)
  const tamperFlags: TamperFlag[] = [];
  for (let i = 0; i < 3; i++) {
    const name = confusableName(80);
    const id = stageBb.createVariable(name, 0);
    tamperFlags.push({ name, id });
  }

  // Create sentinel variables on each target
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

  project._antiTamperContext = {
    tamperFlags,
    targetSentinels,
    config: config.antiTamper,
  };
}

// ── Phase 1b: Standalone scripts (type D only) ──────────────────

/**
 * Inject standalone green-flag scripts for check types that can't be
 * merged into CFF state machines (type D: tamper flag monitors).
 */
export function applyAntiTamper(
  project: SB3Project,
  config: ObfuscatorConfig,
  opts?: ObfuscateOptions,
): void {
  if (!config.antiTamper.enabled) return;
  const ctx = project._antiTamperContext;
  if (!ctx) return;

  const stage = project.targets.find(t => t.isStage);
  if (!stage) return;

  const sprites = project.targets.filter(
    t => !t.isStage && isTargetSelected(t, opts),
  );

  const at = config.antiTamper;

  // Type D: Tamper flag monitors (standalone forever-loop scripts)
  if (at.tamperFlagMonitors) {
    for (const target of [stage, ...sprites]) {
      const bb = new BlockBuilder(target);
      injectFlagMonitor(bb, ctx.tamperFlags);
    }
  }
}

// ── Phase 2 (during CFF): Generate tamper check states ──────────

/**
 * Build condition boolean block for a check type, returning the block ID
 * of the "everything is OK" boolean.
 */
function buildCheckCondition(
  bb: BlockBuilder,
  type: string,
  ctx: AntiTamperContext,
  target: SB3Target,
  sprites: SB3Target[],
): string | null {
  const sents = ctx.targetSentinels.get(target);
  if (!sents || sents.length === 0) return null;

  switch (type) {
    case 'A': {
      // Sentinel value check: sentinel == magic
      const s = sents[randomInt(0, sents.length - 1)];
      const readId = bb.readVariable(s.name, s.id);
      const magicId = bb.numberLiteral(s.magic);
      const eqId = bb.comparison('operator_equals', readId, magicId);
      bb.setParent(readId, eqId);
      bb.setParent(magicId, eqId);
      return eqId;
    }
    case 'B': {
      // Self sensing_of (static)
      const s = sents[0];
      const objName = sensingObjectName(target);
      const sensingId = buildSensingOf(bb, objName, s.name, false);
      const magicId = bb.numberLiteral(s.magic);
      const eqId = bb.comparison('operator_equals', sensingId, magicId);
      bb.setParent(sensingId, eqId);
      bb.setParent(magicId, eqId);
      return eqId;
    }
    case 'C': {
      // Self sensing_of (dynamic — name in variable)
      if (sents.length < 2) return null;
      const s = sents[1];
      const objName = sensingObjectName(target);
      const sensingId = buildSensingOf(bb, objName, s.name, true);
      const magicId = bb.numberLiteral(s.magic);
      const eqId = bb.comparison('operator_equals', sensingId, magicId);
      bb.setParent(sensingId, eqId);
      bb.setParent(magicId, eqId);
      return eqId;
    }
    case 'E': {
      // List integrity check
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

      const idxId = bb.numberLiteral(checkIdx + 1);
      const itemId = bb.itemOfList(listName, listId, idxId);
      bb.setParent(idxId, itemId);
      const expectedValId = bb.numberLiteral(expectedValue);
      const valEqId = bb.comparison('operator_equals', itemId, expectedValId);
      bb.setParent(itemId, valEqId);
      bb.setParent(expectedValId, valEqId);

      const andId = bb.and(lenEqId, valEqId);
      bb.setParent(lenEqId, andId);
      bb.setParent(valEqId, andId);
      return andId;
    }
    case 'F': {
      // Variable cross-reference
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
      return andId;
    }
    case 'H': {
      // Cross-sprite sensing_of — check another sprite's sentinel
      if (sprites.length < 2 && !target.isStage) {
        // Need at least one other sprite
        const otherSprites = sprites.filter(s => s !== target);
        if (otherSprites.length === 0) return null;
        const other = otherSprites[randomInt(0, otherSprites.length - 1)];
        const otherSents = ctx.targetSentinels.get(other);
        if (!otherSents || otherSents.length === 0) return null;
        const s = otherSents[0];
        const dynamic = randomInt(0, 1) === 1;
        const sensingId = buildSensingOf(bb, other.name, s.name, dynamic);
        const magicId = bb.numberLiteral(s.magic);
        const eqId = bb.comparison('operator_equals', sensingId, magicId);
        bb.setParent(sensingId, eqId);
        bb.setParent(magicId, eqId);
        return eqId;
      }
      // Pick a different target to check
      const allTargets = [...ctx.targetSentinels.keys()];
      const others = allTargets.filter(t => t !== target);
      if (others.length === 0) return null;
      const other = others[randomInt(0, others.length - 1)];
      const otherSents = ctx.targetSentinels.get(other)!;
      if (otherSents.length === 0) return null;
      const s = otherSents[randomInt(0, otherSents.length - 1)];
      const objName = sensingObjectName(other);
      const dynamic = randomInt(0, 1) === 1;
      const sensingId = buildSensingOf(bb, objName, s.name, dynamic);
      const magicId = bb.numberLiteral(s.magic);
      const eqId = bb.comparison('operator_equals', sensingId, magicId);
      bb.setParent(sensingId, eqId);
      bb.setParent(magicId, eqId);
      return eqId;
    }
    case 'K': {
      // Encoded flag system: a*b + c = magic
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
      return eqId;
    }
    default:
      return null;
  }
}

/**
 * Generate tamper check states to splice into a CFF state machine.
 *
 * Each check = 2 states:
 *   1. Branch state: condition ok? → truePc=continuation, falsePc=tamperResponse
 *   2. Tamper response state (shared): set flags, terminal (nextPc=EXIT)
 *
 * @param bb - BlockBuilder for the target
 * @param project - the project (for _antiTamperContext)
 * @param target - the target being flattened
 * @param existingStates - the existing CFG states to pick splice points from
 * @param allocPc - function to allocate a new unique PC value
 * @param exitPc - the EXIT_PC value (0)
 * @returns states to add and redirects to apply
 */
export function generateTamperCheckStates(
  bb: BlockBuilder,
  project: SB3Project,
  target: SB3Target,
  existingStates: { pc: number; nextPc: number; bodyBlockIds: string[]; branch?: any; isTerminal?: boolean; isDead: boolean }[],
  allocPc: () => number,
  exitPc: number,
): TamperCheckResult {
  const ctx = project._antiTamperContext!;
  const at = ctx.config;
  const result: TamperCheckResult = { states: [], redirects: new Map() };

  // Collect all sprites for cross-sprite checks
  const sprites = [...ctx.targetSentinels.keys()].filter(t => !t.isStage);

  // Determine which check types to generate
  const checkTypes: string[] = [];
  if (at.hiddenVariableChecks) checkTypes.push('A');
  if (at.sensingOfSelfChecks) checkTypes.push('B', 'C');
  if (at.hiddenListChecks) checkTypes.push('E');
  if (at.pairedVariableChecks) checkTypes.push('F');
  if (at.crossSpriteVerification) checkTypes.push('H');
  if (at.mathematicalFlagChecks) checkTypes.push('K');

  if (checkTypes.length === 0) return result;

  // Pick splice-able states: linear (no branch, not terminal, not dead)
  const spliceableIndices: number[] = [];
  for (let i = 0; i < existingStates.length; i++) {
    const s = existingStates[i];
    if (!s.branch && !s.isTerminal && !s.isDead && s.nextPc !== exitPc) {
      spliceableIndices.push(i);
    }
  }

  if (spliceableIndices.length === 0) return result;

  // Decide how many checks to inject (1 per check type, max = available splice points)
  const numChecks = Math.min(checkTypes.length, spliceableIndices.length);

  // Shuffle splice points and check types
  const shuffledIndices = [...spliceableIndices].sort(() => Math.random() - 0.5);
  const shuffledTypes = [...checkTypes].sort(() => Math.random() - 0.5).slice(0, numChecks);

  // Build shared tamper response state (set flags + terminal → EXIT)
  const tamperResponsePc = allocPc();
  const flagSetIds: string[] = [];
  for (const flag of ctx.tamperFlags) {
    flagSetIds.push(bb.setVariable(flag.name, flag.id, 1));
  }
  if (flagSetIds.length > 1) {
    for (let j = 0; j < flagSetIds.length - 1; j++) {
      bb.setNext(flagSetIds[j], flagSetIds[j + 1]);
      bb.setParent(flagSetIds[j + 1], flagSetIds[j]);
    }
  }
  result.states.push({
    pc: tamperResponsePc,
    bodyBlockIds: flagSetIds,
    nextPc: exitPc,
    isTerminal: true,
    isDead: false,
  });

  // Generate each check
  for (let i = 0; i < numChecks; i++) {
    const stateIdx = shuffledIndices[i];
    const checkType = shuffledTypes[i];
    const state = existingStates[stateIdx];

    const conditionId = buildCheckCondition(bb, checkType, ctx, target, sprites);
    if (!conditionId) continue;

    const branchPc = allocPc();
    const originalNextPc = state.nextPc;

    // Create branch state: condition ok → continuation, not ok → tamper response
    result.states.push({
      pc: branchPc,
      bodyBlockIds: [],
      nextPc: originalNextPc, // fallthrough (not used when branch is set)
      branch: {
        conditionBlockId: conditionId,
        truePc: originalNextPc,
        falsePc: tamperResponsePc,
      },
      isDead: false,
    });

    // Redirect the existing state's nextPc through the branch
    state.nextPc = branchPc;
  }

  return result;
}

// ── Separate late-phase entry point for type L ───────────────────

/**
 * Inject a string-list checksum check (type L).
 * Must run AFTER constants obfuscation so _constListInfo is populated.
 */
export function applyStringListChecksum(
  project: SB3Project,
  config: ObfuscatorConfig,
): void {
  if (!config.antiTamper.enabled || !config.antiTamper.stringListChecksum) return;
  if (!project._constListInfo) return;

  const stage = project.targets.find(t => t.isStage);
  if (!stage) return;

  const { id: listId, name: listName } = project._constListInfo;
  const listData = stage.lists[listId];
  if (!listData || listData[1].length === 0) return;

  const bb = new BlockBuilder(stage);

  // Create fresh tamper flags (can't easily find originals)
  const tamperFlags: TamperFlag[] = [];
  for (let i = 0; i < 3; i++) {
    const name = confusableName(80);
    const id = bb.createVariable(name, 0);
    tamperFlags.push({ name, id });
  }

  let expectedChecksum = 0;
  for (const item of listData[1]) {
    expectedChecksum += String(item).length;
  }
  injectStringListChecksumCheck(bb, listName, listId, expectedChecksum, tamperFlags);
}

// ── String list checksum implementation ──────────────────────────

function injectStringListChecksumCheck(
  bb: BlockBuilder,
  listName: string,
  listId: string,
  expectedChecksum: number,
  tamperFlags: TamperFlag[],
): void {
  const sumVarName = confusableName(80);
  const sumVarId = bb.createVariable(sumVarName, 0);
  const iVarName = confusableName(80);
  const iVarId = bb.createVariable(iVarName, 0);

  const readI = bb.readVariable(iVarName, iVarId);
  const itemOfId = bb.itemOfList(listName, listId, readI);
  bb.setParent(readI, itemOfId);

  const lengthId = bb.createBlock({
    opcode: 'operator_length',
    inputs: { STRING: [INPUT_BLOCK_NO_SHADOW, itemOfId] },
  });
  bb.setParent(itemOfId, lengthId);

  const changeSumId = bb.createBlock({
    opcode: 'data_changevariableby',
    inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, lengthId] },
    fields: { VARIABLE: [sumVarName, sumVarId] },
  });
  bb.setParent(lengthId, changeSumId);

  const changeIId = bb.changeVariable(iVarName, iVarId, 1);
  bb.chain(changeSumId, changeIId);

  const listLengthId = bb.lengthOfList(listName, listId);
  const repeatId = bb.controlRepeat(listLengthId, changeSumId);
  bb.setParent(listLengthId, repeatId);
  bb.setParent(changeSumId, repeatId);

  const setSumId = bb.setVariable(sumVarName, sumVarId, 0);
  const setIId = bb.setVariable(iVarName, iVarId, 1);
  bb.chain(setSumId, setIId, repeatId);

  const readSum = bb.readVariable(sumVarName, sumVarId);
  const expectedLit = bb.numberLiteral(expectedChecksum);
  const eqId = bb.comparison('operator_equals', readSum, expectedLit);
  bb.setParent(readSum, eqId);
  bb.setParent(expectedLit, eqId);

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

  const hatId = bb.createBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true,
    x: randomInt(-2000, 2000),
    y: randomInt(-2000, 2000),
  });
  bb.chain(hatId, setSumId);
}
