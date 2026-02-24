/**
 * Control Flow Flattening (CFF) — Thread-Safe with Separate List Architecture
 *
 * Architecture:
 * - FOUR core lists per target (sprite/stage), plus optional wait lists:
 *   - pcIds:       thread identifiers (one per active thread)
 *   - pcVals:      PC values (parallel with pcIds)
 *   - counterKeys: repeat counter keys (separate KV store)
 *   - counterVals: repeat counter values (parallel with counterKeys)
 *   [only if control_wait or event_broadcastandwait is used:]
 *   - waitFlags:   wait type flag (parallel with pcIds): 0=not waiting, 1=timer, -1=broadcast
 *   - bcastPendingMsg: wait data (duration or broadcast name, parallel with pcIds)
 *   - waitQueue:   FIFO queue of threadIds pending wait handling
 *
 * - The CALLER generates the random thread identifier (−999999999999 to 999999999999)
 *   and passes it as the first argument to run_N.
 *   To find its PC: item (item# of <id> in pcIds) of pcVals
 *
 * - TWO custom blocks per flattened script:
 *   - step_N(id, args...) :: WARP — inner dispatch loop (BST)
 *   - run_N(id, args...)  :: NOT warp — outer tick loop, init/cleanup
 *     (for procedures, args... = original procedure parameters forwarded through)
 *
 * - Hat block calls run_N(pick random) (threadId only).
 *   Procedure definition calls run_N(pick random, arg1, arg2, ...) forwarding all params.
 *
 * - Repeat counters use a key-value store:
 *   Key = join(threadId, join(" ", loopStaticId))
 *   loopStaticId is a compile-time UID per repeat loop.
 *
 * - Wait (control_wait) uses a broadcast mechanism:
 *   step_N stores duration in waitFlags, adds threadId to waitQueue, broadcasts.
 *   A broadcast receiver processes ONE entry from the queue, re-broadcasts
 *   for remaining entries (spawning parallel handler threads), then calls
 *   handleWait(threadId) — NOT warp — which waits the duration and clears the flag.
 *   handleWait uses NO shared variables (all index lookups are inline from threadId).
 *   A poll state in step_N checks waitFlags each tick until 0.
 *
 * - Broadcast-and-wait (event_broadcastandwait) uses the same mechanism:
 *   step_N stores msg in bcastPendingMsg, sets waitFlags=-1, enqueues, broadcasts.
 *   handleWait detects flag=-1, does broadcast-and-wait on the stored msg, clears flag.
 *
 * - Wait until (control_wait_until) simply yields each tick until condition is met.
 *
 * Thread-safe: each thread has a unique random identifier.
 * BST uses ONLY operator_lt (no equals). PC values are huge random numbers.
 */

import {
  SB3Target, SB3Block, SB3Project, isSB3Block, isSB3Primitive,
  INPUT_SAME_BLOCK_SHADOW, INPUT_BLOCK_NO_SHADOW,
  MATH_NUM_PRIMITIVE, TEXT_PRIMITIVE,
} from '../types';
import { BlockBuilder } from '../blocks';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { uid, confusableName, randomInt, randomBool, shuffle } from '../uid';
import { generateDeadCodeChain, generateDynamicDeadCodeChain, DeadCodeContext } from './deadcode';
import { BlockList } from 'net';

// ── Constants ─────────────────────────────────────────────────────

const HAT_OPCODES = new Set([
  'event_whenflagclicked',
  'event_whenkeypressed',
  'event_whenthisspriteclicked',
  'event_whenstageclicked',
  'event_whenbackdropswitchesto',
  'event_whengreaterthan',
  'event_whenbroadcastreceived',
  'control_start_as_clone',
]);

const C_BLOCK_OPCODES = new Set([
  'control_if',
  'control_if_else',
  'control_repeat',
  'control_repeat_until',
  'control_while',
  'control_for_each',
  'control_all_at_once',
  'control_forever',
]);

const TERMINATOR_OPCODES = new Set([
  'control_forever',
  'control_stop',
  'control_delete_this_clone',
]);

const PC_MIN = -10_000_000_000_000;
const PC_MAX = 10_000_000_000_000;
const EXIT_PC = 0;

/** Module-level set collecting block IDs of CFF PC-transition primitives/operators.
 *  Populated during applyCFF, attached to project._cffPcBlockIds for the constants pass. */
let _pcBlockIds: Set<string> = new Set();

// ── Types ─────────────────────────────────────────────────────────

interface CFGState {
  pc: number;
  bodyBlockIds: string[];
  nextPc: number;
  branch?: {
    conditionBlockId: string;
    truePc: number;
    falsePc: number;
  };
  repeatInit?: {
    countExprBlockId: string;
    loopStaticId: string;
  };
  repeatCheck?: {
    loopStaticId: string;
    bodyPc: number;
    exitPc: number;
  };
  isTerminal?: boolean;
  /** Wait start: store duration, enqueue threadId, broadcast, yield */
  waitStart?: {
    durationExprBlockId: string;
    pollPc: number;
  };
  /** Wait poll: timer-based (isTimer=true) or broadcast-and-wait (isTimer=false) */
  waitPoll?: {
    continuationPc: number;
    isTimer: boolean;
  };
  /** Broadcast-and-wait start: store msg, enqueue, broadcast signal, yield */
  broadcastWaitStart?: {
    broadcastExprBlockId: string;
    pollPc: number;
  };
  /** For-each init: compute ceil(N) and store counter + bound in KV store */
  forEachInit?: {
    valueExprBlockId: string;
    loopCounterStaticId: string;
    loopBoundStaticId: string;
  };
  /** For-each check: counter < bound? Increment, set variable, body; else cleanup + exit */
  forEachCheck?: {
    varName: string;
    varId: string | null;
    loopCounterStaticId: string;
    loopBoundStaticId: string;
    bodyPc: number;
    exitPc: number;
  };
  isDead: boolean;
}

/** Shared lists created once per target */
interface TargetCFFLists {
  pcIdName: string; pcIdId: string;
  pcValName: string; pcValId: string;
  counterKeyName: string; counterKeyId: string;
  counterValName: string; counterValId: string;

  /** Present only when at least one script uses control_wait or event_broadcastandwait */
  waitFlagName: string; waitFlagId: string;
  /** Stores the pending broadcast message / wait duration per thread.
   *  Present only when wait infrastructure is needed. */
  bcastPendingMsgName: string; bcastPendingMsgId: string;
  /** FIFO queue of threadIds that need wait handling.
   *  Present only when wait infrastructure is needed. */
  waitQueueName: string; waitQueueId: string;
  /** Broadcast signal that triggers the wait handler receiver.
   *  Present only when wait infrastructure is needed. */
  waitBroadcastName: string; waitBroadcastId: string;

  /** Broadcast fired by the cleanup hat after all lists are cleared.
   *  when-green-flag CFF scripts listen for this instead of the flag,
   *  guaranteeing lists are empty before any run_N touches them. */
  startBroadcastName: string; startBroadcastId: string;

  /** Whether this target has any control_wait usage */
  hasTimerWait: boolean;
  /** Whether this target has any event_broadcastandwait usage */
  hasBroadcastWait: boolean;
}

/** Per-script CFF context */
interface ScriptCFFContext {
  lists: TargetCFFLists;
  runProccode: string;
  runArgIds: string[];
  runArgNames: string[];
  /** Format specs for forwarded args: 's' for string/number, 'b' for boolean */
  runArgTypes: string[];
  stepProccode: string;
  stepArgIds: string[];
  stepArgNames: string[];
  cachedPcVarName: string; cachedPcVarId: string;
  keepGoingVarName: string; keepGoingVarId: string;
  baseIndexVarName: string; baseIndexVarId: string;
}

// ── Main entry ────────────────────────────────────────────────────

export function applyCFF(project: SB3Project, config: ObfuscatorConfig, opts?: ObfuscateOptions): void {
  if (!config.cff.enabled) return;
  _pcBlockIds = new Set();
  const stage = project.targets.find(t => t.isStage) || project.targets[0];
  for (const target of project.targets) {
    if (!isTargetSelected(target, opts)) continue;
    applyCFFToTarget(project, target, config, stage);
  }
  project._cffPcBlockIds = _pcBlockIds;
}

function applyCFFToTarget(project: SB3Project, target: SB3Target, config: ObfuscatorConfig, stage: SB3Target): void {
  const bb = new BlockBuilder(target);
  const deadCtx = createDeadCodeContext(target, bb, stage);

  // Collect hat blocks and procedure definitions
  const hatBlockIds: string[] = [];
  for (const [id, block] of Object.entries(target.blocks)) {
    if (isSB3Block(block) && block.topLevel && HAT_OPCODES.has(block.opcode)) {
      hatBlockIds.push(id);
    }
  }
  const procDefIds: string[] = [];
  if (config.cff.flattenProcedures) {
    for (const [id, block] of Object.entries(target.blocks)) {
      if (isSB3Block(block) && block.opcode === 'procedures_definition') {
        procDefIds.push(id);
      }
    }
  }

  // Check if any scripts will actually be CFF'd
  let hasCFFWork = false;
  for (const hatId of hatBlockIds) {
    const hatBlock = bb.getFullBlock(hatId);
    if (hatBlock && hatBlock.next) {
      const chain = bb.walkChain(hatBlock.next);
      if (chain.length >= config.cff.minBlocksToFlatten) { hasCFFWork = true; break; }
    }
  }
  if (!hasCFFWork && config.cff.flattenProcedures) {
    for (const defId of procDefIds) {
      const defBlock = bb.getFullBlock(defId);
      if (defBlock && defBlock.next) {
        const chain = bb.walkChain(defBlock.next);
        if (chain.length >= config.cff.minBlocksToFlatten) { hasCFFWork = true; break; }
      }
    }
  }
  if (!hasCFFWork) return;

  // ── Pre-scan ALL blocks in target for wait opcodes ──
  let hasTimerWait = false;
  let hasBroadcastWait = false;
  for (const [, block] of Object.entries(target.blocks)) {
    if (!isSB3Block(block)) continue;
    if (block.opcode === 'control_wait') hasTimerWait = true;
    if (block.opcode === 'event_broadcastandwait') hasBroadcastWait = true;
    if (hasTimerWait && hasBroadcastWait) break;
  }

  // ── Create shared target infrastructure ──
  const lists = createTargetLists(target, bb, stage, hasTimerWait, hasBroadcastWait);
  buildGreenFlagCleanup(bb, lists);
  if (hasTimerWait || hasBroadcastWait) {
    const preWaitIds = new Set(Object.keys(target.blocks));
    buildWaitHandler(target, bb, lists);
    if (!project._cffWaitHandlerBlockIds) project._cffWaitHandlerBlockIds = new Set();
    for (const id of Object.keys(target.blocks)) {
      if (!preWaitIds.has(id)) project._cffWaitHandlerBlockIds.add(id);
    }
  }

  // ── Flatten each script ──
  for (const hatId of hatBlockIds) {
    flattenHatScript(target, bb, hatId, config, deadCtx, lists);
  }
  for (const defId of procDefIds) {
    flattenProcedureBody(target, bb, defId, config, deadCtx, lists);
  }
}

// ── Create shared lists for a target ──────────────────────────────

function createTargetLists(
  target: SB3Target, bb: BlockBuilder, stage: SB3Target,
  hasTimerWait: boolean, hasBroadcastWait: boolean,
): TargetCFFLists {
  const needsWait = hasTimerWait || hasBroadcastWait;

  const pcIdName = confusableName(); const pcIdId = bb.createList(pcIdName, []);
  target.lists[pcIdId] = [pcIdName, []];
  const pcValName = confusableName(); const pcValId = bb.createList(pcValName, []);
  target.lists[pcValId] = [pcValName, []];
  const counterKeyName = confusableName(); const counterKeyId = bb.createList(counterKeyName, []);
  target.lists[counterKeyId] = [counterKeyName, []];
  const counterValName = confusableName(); const counterValId = bb.createList(counterValName, []);
  target.lists[counterValId] = [counterValName, []];

  // Wait-related lists — only created if any script uses control_wait or broadcastandwait
  let waitFlagName = '', waitFlagId = '';
  let bcastPendingMsgName = '', bcastPendingMsgId = '';
  let waitQueueName = '', waitQueueId = '';
  let waitBroadcastName = '', waitBroadcastId = '';

  if (needsWait) {
    waitFlagName = confusableName(); waitFlagId = bb.createList(waitFlagName, []);
    target.lists[waitFlagId] = [waitFlagName, []];

    bcastPendingMsgName = confusableName(); bcastPendingMsgId = bb.createList(bcastPendingMsgName, []);
    target.lists[bcastPendingMsgId] = [bcastPendingMsgName, []];

    waitQueueName = confusableName(); waitQueueId = bb.createList(waitQueueName, []);
    target.lists[waitQueueId] = [waitQueueName, []];

    waitBroadcastName = confusableName();
    waitBroadcastId = uid();
    stage.broadcasts[waitBroadcastId] = waitBroadcastName;
  }

  // Fired by the cleanup hat once all lists are cleared, so CFF scripts that
  // originally used event_whenflagclicked only start after initialization.
  const startBroadcastName = confusableName();
  const startBroadcastId = uid();
  stage.broadcasts[startBroadcastId] = startBroadcastName;

  return {
    pcIdName, pcIdId, pcValName, pcValId,
    waitFlagName, waitFlagId,
    counterKeyName, counterKeyId, counterValName, counterValId,
    bcastPendingMsgName, bcastPendingMsgId,
    waitQueueName, waitQueueId,
    waitBroadcastName, waitBroadcastId,
    startBroadcastName, startBroadcastId,
    hasTimerWait, hasBroadcastWait,
  };
}

// ── Green flag cleanup hat ────────────────────────────────────────

function buildGreenFlagCleanup(bb: BlockBuilder, lists: TargetCFFLists): void {
  const clears: string[] = [
    bb.deleteAllOfList(lists.pcIdName, lists.pcIdId),
    bb.deleteAllOfList(lists.pcValName, lists.pcValId),
    bb.deleteAllOfList(lists.counterKeyName, lists.counterKeyId),
    bb.deleteAllOfList(lists.counterValName, lists.counterValId),
  ];
  if (lists.hasTimerWait || lists.hasBroadcastWait) {
    clears.push(bb.deleteAllOfList(lists.waitFlagName, lists.waitFlagId));
    clears.push(bb.deleteAllOfList(lists.bcastPendingMsgName, lists.bcastPendingMsgId));
    clears.push(bb.deleteAllOfList(lists.waitQueueName, lists.waitQueueId));
  }

  // After all lists are cleared, broadcast the start signal so that
  // CFF-flattened green-flag scripts only begin once lists are empty.
  const startPrimId = bb.broadcastPrimitive(lists.startBroadcastName, lists.startBroadcastId);
  const startBroadcast = bb.createBlock({
    opcode: 'event_broadcast',
    inputs: { BROADCAST_INPUT: [INPUT_SAME_BLOCK_SHADOW, startPrimId] },
  });
  bb.setParent(startPrimId, startBroadcast);

  const chain = [...clears, startBroadcast];
  for (let i = 0; i < chain.length - 1; i++) {
    bb.setNext(chain[i], chain[i + 1]);
    bb.setParent(chain[i + 1], chain[i]);
  }
  const hatId = bb.createBlock({
    opcode: 'event_whenflagclicked',
    topLevel: true, next: chain[0], x: -9999, y: -9999,
  });
  bb.setParent(chain[0], hatId);
}

// ── Wait handler infrastructure (per target) ──────────────────────
//
//   when I receive [waitBroadcast]:
//     if (length of waitQueue > 0):
//       set [savedTid] to (item 1 of waitQueue)
//       delete 1 of waitQueue
//       if (length of waitQueue > 0): broadcast [waitBroadcast]  // spawn parallel handler
//       handleWait(savedTid)
//
//   define handleWait %s (threadId) — NOT warp (screen refresh):
//     // NO shared variables — all index lookups are inline for thread safety
//     if (item (item# of threadId in pcIds) of waitFlags) > 0:  // timer wait
//       wait (item (item# of threadId in pcIds) of waitFlags) seconds
//       replace item (item# of threadId in pcIds) of waitFlags with 0
//     else:                                                       // broadcast-and-wait
//       broadcast (item (item# of threadId in pcIds) of bcastPendingMsg) and wait
//       replace item (item# of threadId in pcIds) of waitFlags with 0

function buildWaitHandler(target: SB3Target, bb: BlockBuilder, lists: TargetCFFLists): void {
  // ── handleWait custom block (NOT warp → screen refresh, so waits actually yield) ──
  // Thread-safe: NO shared variables. Every operation computes the list index
  // inline from the threadId argument, so concurrent handleWait calls don't conflict.
  const hwArgId = uid();
  const hwArgName = confusableName(30);
  const hwProccode = confusableName(40) + ' %s';

  const { definitionId: hwDefId } = bb.procedureDefinition(
    hwProccode, [hwArgName], [hwArgId], false, null,
  );

  // Helper: build inline (item# of threadId in pcIds) — fresh blocks each call
  function inlineBaseIndex(): string {
    const tidArg = bb.argumentReporter(hwArgName);
    const idx = bb.itemNumOfList(lists.pcIdName, lists.pcIdId, tidArg);
    bb.setParent(tidArg, idx);
    return idx;
  }

  // Helper: read waitFlags at inline index
  function readFlagInline(): string {
    const idx = inlineBaseIndex();
    const flagRead = bb.itemOfList(lists.waitFlagName, lists.waitFlagId, idx);
    bb.setParent(idx, flagRead);
    return flagRead;
  }

  // Helper: read bcastPendingMsg (wait data) at inline index
  function readDataInline(): string {
    const idx = inlineBaseIndex();
    const dataRead = bb.itemOfList(lists.bcastPendingMsgName, lists.bcastPendingMsgId, idx);
    bb.setParent(idx, dataRead);
    return dataRead;
  }

  // Helper: build "clear waitFlags[idx] = 0" block
  function buildClearFlag(): string {
    const clearIdx = inlineBaseIndex();
    const zeroLit = bb.numberLiteral(0);
    const clearFlag = bb.replaceItemOfList(
      lists.waitFlagName, lists.waitFlagId, clearIdx, zeroLit,
    );
    bb.setParent(clearIdx, clearFlag);
    bb.setParent(zeroLit, clearFlag);
    return clearFlag;
  }

  let hwBodyId: string;

  if (lists.hasTimerWait && lists.hasBroadcastWait) {
    // ── Both: if-else on waitFlags > 0 ──
    const flagForCond = readFlagInline();
    const zeroLitCond = bb.numberLiteral(0);
    const isTimerWait = bb.comparison('operator_gt', flagForCond, zeroLitCond);
    bb.setParent(flagForCond, isTimerWait);

    // True branch: timer wait
    const durRead = readDataInline();
    const waitBlock = bb.controlWait(durRead);
    bb.setParent(durRead, waitBlock);
    const clearFlag1 = buildClearFlag();
    bb.chain(waitBlock, clearFlag1);

    // False branch: broadcast-and-wait
    const msgIdx = inlineBaseIndex();
    const msgRead = bb.itemOfList(lists.bcastPendingMsgName, lists.bcastPendingMsgId, msgIdx);
    bb.setParent(msgIdx, msgRead);
    const bcastAndWait = bb.createBlock({
      opcode: 'event_broadcastandwait',
      inputs: { BROADCAST_INPUT: [INPUT_BLOCK_NO_SHADOW, msgRead] },
    });
    bb.setParent(msgRead, bcastAndWait);
    const clearFlag2 = buildClearFlag();
    bb.chain(bcastAndWait, clearFlag2);

    hwBodyId = bb.controlIfElse(isTimerWait, waitBlock, bcastAndWait);
    bb.setParent(isTimerWait, hwBodyId);
    bb.setParent(waitBlock, hwBodyId);
    bb.setParent(bcastAndWait, hwBodyId);

  } else if (lists.hasTimerWait) {
    // ── Timer wait only — no branching needed ──
    const durRead = readDataInline();
    const waitBlock = bb.controlWait(durRead);
    bb.setParent(durRead, waitBlock);
    const clearFlag = buildClearFlag();
    bb.chain(waitBlock, clearFlag);
    hwBodyId = waitBlock;

  } else {
    // ── Broadcast-and-wait only — no branching needed ──
    const msgIdx = inlineBaseIndex();
    const msgRead = bb.itemOfList(lists.bcastPendingMsgName, lists.bcastPendingMsgId, msgIdx);
    bb.setParent(msgIdx, msgRead);
    const bcastAndWait = bb.createBlock({
      opcode: 'event_broadcastandwait',
      inputs: { BROADCAST_INPUT: [INPUT_BLOCK_NO_SHADOW, msgRead] },
    });
    bb.setParent(msgRead, bcastAndWait);
    const clearFlag = buildClearFlag();
    bb.chain(bcastAndWait, clearFlag);
    hwBodyId = bcastAndWait;
  }

  const hwDef = bb.getFullBlock(hwDefId)!;
  hwDef.next = hwBodyId;
  bb.setParent(hwBodyId, hwDefId);

  // ── Broadcast receiver: when I receive [waitBroadcast] ──
  //   Thread-safe approach: process ONE entry, then re-broadcast for remaining.
  //   Each broadcast creates a fresh receiver thread, so concurrent waits
  //   each get their own independent thread (no receiver restart killing
  //   an in-flight handleWait).
  //
  //   if (length of waitQueue > 0):
  //     set [savedTid] to (item 1 of waitQueue)
  //     delete 1 of waitQueue
  //     if (length of waitQueue > 0): broadcast [waitBroadcast]  // spawn handler for next
  //     handleWait(savedTid)

  // Variable to save the threadId before deleting from queue
  const savedTidName = confusableName();
  const savedTidId = bb.createVariable(savedTidName, 0);

  // Outer condition: length of waitQueue > 0
  const lenRead = bb.lengthOfList(lists.waitQueueName, lists.waitQueueId);
  const zeroLitLen = bb.numberLiteral(0);
  const hasEntries = bb.comparison('operator_gt', lenRead, zeroLitLen);
  bb.setParent(lenRead, hasEntries);

  // Save item 1 to variable (before deleting)
  const item1Read = bb.itemOfList(lists.waitQueueName, lists.waitQueueId, bb.numberLiteral(1));
  const saveTid = bb.setVariableToBlock(savedTidName, savedTidId, item1Read);
  bb.setParent(item1Read, saveTid);

  // Delete item 1 of waitQueue
  const oneLitDel = bb.numberLiteral(1);
  const delFirst = bb.deleteOfList(lists.waitQueueName, lists.waitQueueId, oneLitDel);

  // If more entries remain, re-broadcast to spawn a new handler thread
  const lenRead2 = bb.lengthOfList(lists.waitQueueName, lists.waitQueueId);
  const zeroLitLen2 = bb.numberLiteral(0);
  const hasMore = bb.comparison('operator_gt', lenRead2, zeroLitLen2);
  bb.setParent(lenRead2, hasMore);

  const reBcastPrimId = bb.broadcastPrimitive(lists.waitBroadcastName, lists.waitBroadcastId);
  const reBroadcast = bb.createBlock({
    opcode: 'event_broadcast',
    inputs: { BROADCAST_INPUT: [INPUT_SAME_BLOCK_SHADOW, reBcastPrimId] },
  });
  bb.setParent(reBcastPrimId, reBroadcast);

  const ifMoreId = bb.controlIf(hasMore, reBroadcast);
  bb.setParent(hasMore, ifMoreId);
  bb.setParent(reBroadcast, ifMoreId);

  // Call handleWait(savedTid)
  const savedTidRead = bb.readVariable(savedTidName, savedTidId);
  const callHw = bb.procedureCall(hwProccode, [hwArgId], [savedTidRead], false);
  bb.setParent(savedTidRead, callHw);

  // Chain: saveTid → delFirst → ifMore → callHw
  bb.chain(saveTid, delFirst, ifMoreId, callHw);

  // Wrap in outer if (length > 0)
  const outerIfId = bb.controlIf(hasEntries, saveTid);
  bb.setParent(hasEntries, outerIfId);
  bb.setParent(saveTid, outerIfId);

  // Hat: when I receive [waitBroadcast]
  const hatId = bb.createBlock({
    opcode: 'event_whenbroadcastreceived',
    fields: { BROADCAST_OPTION: [lists.waitBroadcastName, lists.waitBroadcastId] },
    topLevel: true, next: outerIfId, x: -9999, y: -9999,
  });
  bb.setParent(outerIfId, hatId);
}

// ── Flatten a hat-block script ────────────────────────────────────

function flattenHatScript(
  target: SB3Target, bb: BlockBuilder, hatId: string,
  config: ObfuscatorConfig, deadCtx: DeadCodeContext, lists: TargetCFFLists,
): void {
  const hatBlock = bb.getFullBlock(hatId);
  if (!hatBlock || !hatBlock.next) return;
  const chainIds = bb.walkChain(hatBlock.next);
  if (chainIds.length < config.cff.minBlocksToFlatten) return;

  const { states, entryPc, yieldRedirects } = decomposeToCFG(bb, chainIds, config, deadCtx);
  if (states.length === 0) return;

  const ctx = createScriptInfrastructure(target, bb, lists, config);
  buildStepFunction(target, bb, ctx, states, config, yieldRedirects);
  buildRunFunction(target, bb, ctx, entryPc, config);

  // Hat → call run_N(pick random ...)
  const fromLit = bb.numberLiteral(-999999999999);
  const toLit = bb.numberLiteral(999999999999);
  const pickRand = bb.createBlock({
    opcode: 'operator_random',
    inputs: { FROM: [INPUT_SAME_BLOCK_SHADOW, fromLit], TO: [INPUT_SAME_BLOCK_SHADOW, toLit] },
  });
  bb.setParent(fromLit, pickRand);
  bb.setParent(toLit, pickRand);
  const runCall = bb.procedureCall(ctx.runProccode, [ctx.runArgIds[0]], [pickRand], false, hatId, null);
  bb.setParent(pickRand, runCall);

  // Green-flag hats are converted to broadcast receivers so they only fire
  // after the cleanup hat has finished clearing all CFF lists.
  if (hatBlock.opcode === 'event_whenflagclicked') {
    hatBlock.opcode = 'event_whenbroadcastreceived';
    hatBlock.fields = { BROADCAST_OPTION: [lists.startBroadcastName, lists.startBroadcastId] };
  }

  hatBlock.next = runCall;
  bb.setParent(runCall, hatId);
}

// ── Flatten a procedure body ──────────────────────────────────────

function flattenProcedureBody(
  target: SB3Target, bb: BlockBuilder, defId: string,
  config: ObfuscatorConfig, deadCtx: DeadCodeContext, lists: TargetCFFLists,
): void {
  const defBlock = bb.getFullBlock(defId);
  if (!defBlock || !defBlock.next) return;
  const chainIds = bb.walkChain(defBlock.next);
  if (chainIds.length < config.cff.minBlocksToFlatten) return;

  // Extract original procedure's argument info from prototype
  let origArgNames: string[] = [];
  let origArgFormatSpecs: string[] = [];
  const protoInput = defBlock.inputs['custom_block'];
  if (protoInput) {
    const protoId = protoInput[1] as string;
    const protoBlock = protoId ? bb.getFullBlock(protoId) : null;
    if (protoBlock?.mutation) {
      origArgNames = JSON.parse(protoBlock.mutation.argumentnames || '[]');
      const proccode: string = protoBlock.mutation.proccode || '';
      const regex = /(%[sb])/g;
      let m;
      while ((m = regex.exec(proccode)) !== null) {
        origArgFormatSpecs.push(m[1]);
      }
    }
  }

  const { states, entryPc, yieldRedirects } = decomposeToCFG(bb, chainIds, config, deadCtx);
  if (states.length === 0) return;

  const ctx = createScriptInfrastructure(target, bb, lists, config, origArgNames, origArgFormatSpecs);
  buildStepFunction(target, bb, ctx, states, config, yieldRedirects);
  buildRunFunction(target, bb, ctx, entryPc, config);

  // Proc def → call run_N(pick random ..., arg1, arg2, ...) — threadId + forwarded original args
  const fromLitP = bb.numberLiteral(-999999999999);
  const toLitP = bb.numberLiteral(999999999999);
  const pickRandP = bb.createBlock({
    opcode: 'operator_random',
    inputs: { FROM: [INPUT_SAME_BLOCK_SHADOW, fromLitP], TO: [INPUT_SAME_BLOCK_SHADOW, toLitP] },
  });
  bb.setParent(fromLitP, pickRandP);
  bb.setParent(toLitP, pickRandP);

  const runCallInputs: string[] = [pickRandP];
  for (let i = 0; i < origArgNames.length; i++) {
    const isBoolean = origArgFormatSpecs[i] === '%b';
    runCallInputs.push(isBoolean
      ? bb.argumentReporterBoolean(origArgNames[i])
      : bb.argumentReporter(origArgNames[i]));
  }
  const runCall = bb.procedureCall(ctx.runProccode, ctx.runArgIds, runCallInputs, false, defId, null);
  for (const inp of runCallInputs) {
    bb.setParent(inp, runCall);
  }
  defBlock.next = runCall;
  bb.setParent(runCall, defId);
}

// ── CFG Decomposition ─────────────────────────────────────────────

function decomposeToCFG(
  bb: BlockBuilder, chainIds: string[],
  config: ObfuscatorConfig, deadCtx: DeadCodeContext,
): { states: CFGState[]; entryPc: number; yieldRedirects: Map<number, number> } {
  const states: CFGState[] = [];
  const usedPcs = new Set<number>();
  const yieldRedirects = new Map<number, number>();

  function allocPc(): number {
    let pc: number;
    do { pc = randomHugeInt(); } while (usedPcs.has(pc) || pc === EXIT_PC);
    usedPcs.add(pc);
    return pc;
  }

  function decomposeChain(blockIds: string[], continuationPc: number): number {
    if (blockIds.length === 0) return continuationPc;

    const segments: { type: 'linear' | 'control'; blockIds: string[] }[] = [];
    let currentLinear: string[] = [];

    for (const blockId of blockIds) {
      const block = bb.getFullBlock(blockId);
      if (!block) continue;
      if (C_BLOCK_OPCODES.has(block.opcode) || TERMINATOR_OPCODES.has(block.opcode) ||
        block.opcode === 'control_wait' || block.opcode === 'control_wait_until' ||
        block.opcode === 'event_broadcastandwait') {
        if (currentLinear.length > 0) {
          segments.push({ type: 'linear', blockIds: [...currentLinear] });
          currentLinear = [];
        }
        segments.push({ type: 'control', blockIds: [blockId] });
      } else {
        currentLinear.push(blockId);
      }
    }
    if (currentLinear.length > 0) {
      segments.push({ type: 'linear', blockIds: [...currentLinear] });
    }
    if (segments.length === 0) return continuationPc;

    let nextSegmentPc = continuationPc;
    const segmentPcs: number[] = new Array(segments.length);

    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg.type === 'linear') {
        const pc = allocPc();
        segmentPcs[i] = pc;
        for (const bid of seg.blockIds) {
          const b = bb.getFullBlock(bid);
          if (b) { b.next = null; b.parent = null; }
        }
        for (let j = 0; j < seg.blockIds.length - 1; j++) {
          bb.setNext(seg.blockIds[j], seg.blockIds[j + 1]);
          bb.setParent(seg.blockIds[j + 1], seg.blockIds[j]);
        }
        states.push({ pc, bodyBlockIds: seg.blockIds, nextPc: nextSegmentPc, isDead: false });
        nextSegmentPc = pc;
      } else {
        const blockId = seg.blockIds[0];
        const block = bb.getFullBlock(blockId)!;
        const controlPc = decomposeControlBlock(bb, block, blockId, nextSegmentPc, allocPc);
        segmentPcs[i] = controlPc;
        nextSegmentPc = controlPc;
      }
    }
    return segmentPcs[0];
  }

  function decomposeControlBlock(
    bb: BlockBuilder, block: SB3Block, blockId: string,
    continuationPc: number, allocPc: () => number,
  ): number {
    switch (block.opcode) {
      case 'control_if': {
        const condInput = block.inputs['CONDITION'];
        const condBlockId = condInput ? condInput[1] as string : null;
        const substackInput = block.inputs['SUBSTACK'];
        const substackFirstId = substackInput ? substackInput[1] as string : null;

        const branchPc = allocPc();
        let bodyEntryPc = continuationPc;
        if (substackFirstId) {
          bodyEntryPc = decomposeChain(bb.walkChain(substackFirstId), continuationPc);
        }
        if (condBlockId) {
          const condBlock = bb.getFullBlock(condBlockId);
          if (condBlock) condBlock.parent = null;
        }
        states.push({
          pc: branchPc, bodyBlockIds: [], nextPc: continuationPc, isDead: false,
          branch: { conditionBlockId: condBlockId || '', truePc: bodyEntryPc, falsePc: continuationPc },
        });
        bb.deleteBlock(blockId);
        return branchPc;
      }

      case 'control_if_else': {
        const condInput = block.inputs['CONDITION'];
        const condBlockId = condInput ? condInput[1] as string : null;
        const substackInput = block.inputs['SUBSTACK'];
        const substackFirstId = substackInput ? substackInput[1] as string : null;
        const substack2Input = block.inputs['SUBSTACK2'];
        const substack2FirstId = substack2Input ? substack2Input[1] as string : null;

        const branchPc = allocPc();
        let trueEntryPc = continuationPc;
        if (substackFirstId) {
          trueEntryPc = decomposeChain(bb.walkChain(substackFirstId), continuationPc);
        }
        let falseEntryPc = continuationPc;
        if (substack2FirstId) {
          falseEntryPc = decomposeChain(bb.walkChain(substack2FirstId), continuationPc);
        }
        if (condBlockId) {
          const condBlock = bb.getFullBlock(condBlockId);
          if (condBlock) condBlock.parent = null;
        }
        states.push({
          pc: branchPc, bodyBlockIds: [], nextPc: continuationPc, isDead: false,
          branch: { conditionBlockId: condBlockId || '', truePc: trueEntryPc, falsePc: falseEntryPc },
        });
        bb.deleteBlock(blockId);
        return branchPc;
      }

      case 'control_forever': {
        const substackInput = block.inputs['SUBSTACK'];
        const substackFirstId = substackInput ? substackInput[1] as string : null;
        if (substackFirstId) {
          const bodyChain = bb.walkChain(substackFirstId);
          const yieldRedirectPc = allocPc();
          const bodyFirstPc = decomposeChain(bodyChain, yieldRedirectPc);
          yieldRedirects.set(yieldRedirectPc, bodyFirstPc);
          bb.deleteBlock(blockId);
          return bodyFirstPc;
        } else {
          const loopPc = allocPc();
          states.push({ pc: loopPc, bodyBlockIds: [], nextPc: loopPc, isDead: false });
          yieldRedirects.set(loopPc, loopPc);
          bb.deleteBlock(blockId);
          return loopPc;
        }
      }

      case 'control_repeat': {
        const timesInput = block.inputs['TIMES'];
        const timesBlockId = timesInput ? timesInput[1] as string : null;
        const substackInput = block.inputs['SUBSTACK'];
        const substackFirstId = substackInput ? substackInput[1] as string : null;

        const loopStaticId = uid(16);
        const initPc = allocPc();
        const checkPc = allocPc();

        if (timesBlockId) {
          const timesBlock = bb.getFullBlock(timesBlockId);
          if (timesBlock) timesBlock.parent = null;
        }

        const yieldRedirectPc = allocPc();
        yieldRedirects.set(yieldRedirectPc, checkPc);

        let bodyEntryPc: number = yieldRedirectPc;
        if (substackFirstId) {
          bodyEntryPc = decomposeChain(bb.walkChain(substackFirstId), yieldRedirectPc);
        }

        states.push({
          pc: initPc, bodyBlockIds: [], nextPc: checkPc, isDead: false,
          repeatInit: { countExprBlockId: timesBlockId || '', loopStaticId },
        });
        states.push({
          pc: checkPc, bodyBlockIds: [], nextPc: continuationPc, isDead: false,
          repeatCheck: { loopStaticId, bodyPc: bodyEntryPc, exitPc: continuationPc },
        });

        bb.deleteBlock(blockId);
        return initPc;
      }
      case 'control_for_each': {
        // for each [v] in (N): v = 1, 2, ..., ceil(N)
        // The loop counter is tracked independently — internal changes to v are ignored.
        const varField = block.fields['VARIABLE'];
        const varName = varField ? varField[0] : '';
        const varId   = varField ? (varField[1] ?? null) : null;
        const valueInput = block.inputs['VALUE'];
        const valueBlockId = valueInput ? valueInput[1] as string : null;
        const substackInput = block.inputs['SUBSTACK'];
        const substackFirstId = substackInput ? substackInput[1] as string : null;

        if (valueBlockId) {
          const vBlock = bb.getFullBlock(valueBlockId);
          if (vBlock) vBlock.parent = null;
        }

        const loopCounterStaticId = uid(16); // KV key for current index (0-based)
        const loopBoundStaticId   = uid(16); // KV key for ceil(N)
        const initPc  = allocPc();
        const checkPc = allocPc();

        const yieldRedirectPc = allocPc();
        yieldRedirects.set(yieldRedirectPc, checkPc);

        let bodyEntryPc: number = yieldRedirectPc;
        if (substackFirstId) {
          bodyEntryPc = decomposeChain(bb.walkChain(substackFirstId), yieldRedirectPc);
        }

        states.push({
          pc: initPc, bodyBlockIds: [], nextPc: checkPc, isDead: false,
          forEachInit: { valueExprBlockId: valueBlockId || '', loopCounterStaticId, loopBoundStaticId },
        });
        states.push({
          pc: checkPc, bodyBlockIds: [], nextPc: continuationPc, isDead: false,
          forEachCheck: { varName, varId, loopCounterStaticId, loopBoundStaticId, bodyPc: bodyEntryPc, exitPc: continuationPc },
        });

        bb.deleteBlock(blockId);
        return initPc;
      }
      case 'control_repeat_until': {
        const condInput = block.inputs['CONDITION'];
        const condBlockId = condInput ? condInput[1] as string : null;
        const substackInput = block.inputs['SUBSTACK'];
        const substackFirstId = substackInput ? substackInput[1] as string : null;

        const checkPc = allocPc();
        if (condBlockId) {
          const condBlock = bb.getFullBlock(condBlockId);
          if (condBlock) condBlock.parent = null;
        }

        const yieldRedirectPc = allocPc();
        yieldRedirects.set(yieldRedirectPc, checkPc);

        let bodyEntryPc: number = yieldRedirectPc;
        if (substackFirstId) {
          bodyEntryPc = decomposeChain(bb.walkChain(substackFirstId), yieldRedirectPc);
        }

        states.push({
          pc: checkPc, bodyBlockIds: [], nextPc: continuationPc, isDead: false,
          branch: { conditionBlockId: condBlockId || '', truePc: continuationPc, falsePc: bodyEntryPc },
        });
        bb.deleteBlock(blockId);
        return checkPc;
      }
      case 'control_while': {
        const condInput = block.inputs['CONDITION'];
        const condBlockId = condInput ? condInput[1] as string : null;
        const substackInput = block.inputs['SUBSTACK'];
        const substackFirstId = substackInput ? substackInput[1] as string : null;

        const checkPc = allocPc();
        if (condBlockId) {
          const condBlock = bb.getFullBlock(condBlockId);
          if (condBlock) condBlock.parent = null;
        }

        const yieldRedirectPc = allocPc();
        yieldRedirects.set(yieldRedirectPc, checkPc);

        let bodyEntryPc: number = yieldRedirectPc;
        if (substackFirstId) {
          bodyEntryPc = decomposeChain(bb.walkChain(substackFirstId), yieldRedirectPc);
        }

        states.push({
          pc: checkPc, bodyBlockIds: [], nextPc: continuationPc, isDead: false,
          branch: { conditionBlockId: condBlockId || '', truePc: bodyEntryPc, falsePc: continuationPc },
        });
        bb.deleteBlock(blockId);
        return checkPc;
      }

      case 'control_all_at_once': {
        // control_all_at_once has no runtime effect — just unwrap its body.
        const substackInput = block.inputs['SUBSTACK'];
        const substackFirstId = substackInput ? substackInput[1] as string : null;
        bb.deleteBlock(blockId);
        if (substackFirstId) {
          return decomposeChain(bb.walkChain(substackFirstId), continuationPc);
        }
        return continuationPc;
      }

      case 'control_wait': {
        // Extract duration expression
        const durInput = block.inputs['DURATION'];
        let durExprId: string;
        if (durInput) {
          const durVal = durInput[1];
          if (typeof durVal === 'string') {
            const durBlock = bb.getFullBlock(durVal);
            if (durBlock) durBlock.parent = null;
            durExprId = durVal;
          } else if (Array.isArray(durVal)) {
            const numVal = parseFloat(String(durVal[1])) || 0;
            durExprId = bb.numberLiteral(numVal);
          } else {
            durExprId = bb.numberLiteral(0);
          }
        } else {
          durExprId = bb.numberLiteral(0);
        }
        bb.deleteBlock(blockId);

        const startPc = allocPc();
        const pollPc = allocPc();

        states.push({
          pc: startPc, bodyBlockIds: [], nextPc: pollPc, isDead: false,
          waitStart: { durationExprBlockId: durExprId, pollPc },
        });
        states.push({
          pc: pollPc, bodyBlockIds: [], nextPc: continuationPc, isDead: false,
          waitPoll: { continuationPc, isTimer: true },
        });

        return startPc;
      }

      case 'control_wait_until': {
        const condInput = block.inputs['CONDITION'];
        const condBlockId = condInput ? condInput[1] as string : null;

        const checkPc = allocPc();
        const yieldRedirectPc = allocPc();
        yieldRedirects.set(yieldRedirectPc, checkPc);

        if (condBlockId) {
          const condBlock = bb.getFullBlock(condBlockId);
          if (condBlock) condBlock.parent = null;
        }

        states.push({
          pc: checkPc, bodyBlockIds: [], nextPc: continuationPc, isDead: false,
          branch: { conditionBlockId: condBlockId || '', truePc: continuationPc, falsePc: yieldRedirectPc },
        });
        bb.deleteBlock(blockId);
        return checkPc;
      }

      case 'event_broadcastandwait': {
        // Extract broadcast expression
        const bcastInput = block.inputs['BROADCAST_INPUT'];
        let bcastExprId: string;
        if (bcastInput) {
          const bcastVal = bcastInput[1];
          if (typeof bcastVal === 'string') {
            const refBlock = bb.getFullBlock(bcastVal);
            if (refBlock && refBlock.opcode === 'event_broadcast_menu') {
              // Static broadcast name from shadow menu
              const name = (refBlock.fields['BROADCAST_OPTION'] || [])[0] || '';
              bcastExprId = bb.textLiteral(name);
              bb.deleteBlock(bcastVal);
            } else if (refBlock) {
              // Dynamic reporter block
              refBlock.parent = null;
              bcastExprId = bcastVal;
            } else {
              bcastExprId = bb.textLiteral('');
            }
          } else if (Array.isArray(bcastVal)) {
            // Inline primitive [11, name, id]
            const name = String(bcastVal[1]);
            bcastExprId = bb.textLiteral(name);
          } else {
            bcastExprId = bb.textLiteral('');
          }
        } else {
          bcastExprId = bb.textLiteral('');
        }
        bb.deleteBlock(blockId);

        const startPc = allocPc();
        const pollPc = allocPc();

        states.push({
          pc: startPc, bodyBlockIds: [], nextPc: pollPc, isDead: false,
          broadcastWaitStart: { broadcastExprBlockId: bcastExprId, pollPc },
        });
        states.push({
          pc: pollPc, bodyBlockIds: [], nextPc: continuationPc, isDead: false,
          waitPoll: { continuationPc, isTimer: false },
        });

        return startPc;
      }

      case 'control_stop':
      case 'control_delete_this_clone': {
        const pc = allocPc();
        block.parent = null;
        block.next = null;
        states.push({ pc, bodyBlockIds: [blockId], nextPc: EXIT_PC, isTerminal: true, isDead: false });
        return pc;
      }

      default: {
        const pc = allocPc();
        block.parent = null;
        block.next = null;
        states.push({ pc, bodyBlockIds: [blockId], nextPc: continuationPc, isDead: false });
        return pc;
      }
    }
  }

  const entryPc = decomposeChain(chainIds, EXIT_PC);
  const deadStates = generateDeadStates(bb, deadCtx, config, usedPcs);
  states.push(...deadStates);
  const shuffled = shuffle(states);

  return { states: shuffled, entryPc, yieldRedirects };
}

// ── Dead state generation ─────────────────────────────────────────

function generateDeadStates(
  bb: BlockBuilder, deadCtx: DeadCodeContext,
  config: ObfuscatorConfig, usedPcs: Set<number>,
): CFGState[] {
  const deadStates: CFGState[] = [];
  const count = config.cff.deadStatesPerScript;

  for (let i = 0; i < count; i++) {
    let pc: number;
    do { pc = randomHugeInt(); } while (usedPcs.has(pc) || pc === EXIT_PC);
    usedPcs.add(pc);

    const chainLen = randomInt(config.deadCode.minChainLength, config.deadCode.maxChainLength);
    let bodyIds: string[];
    if (config.deadCode.dynamicDeadCode && randomBool()) {
      bodyIds = generateDynamicDeadCodeChain(bb, bb.target, deadCtx, chainLen);
    } else {
      bodyIds = generateDeadCodeChain(bb, bb.target, deadCtx, chainLen);
    }

    for (let j = 0; j < bodyIds.length - 1; j++) {
      bb.setNext(bodyIds[j], bodyIds[j + 1]);
      bb.setParent(bodyIds[j + 1], bodyIds[j]);
    }

    let nextPc: number;
    do { nextPc = randomHugeInt(); } while (nextPc === EXIT_PC);

    deadStates.push({ pc, bodyBlockIds: bodyIds, nextPc, isDead: true });
  }
  return deadStates;
}

// ── Create per-script CFF infrastructure ──────────────────────────

function createScriptInfrastructure(
  target: SB3Target, bb: BlockBuilder,
  lists: TargetCFFLists, config: ObfuscatorConfig,
  origArgNames: string[] = [], origArgFormatSpecs: string[] = [],
): ScriptCFFContext {
  const stepThreadArgId = uid();
  const stepThreadArgName = confusableName(30);

  // Build format string for forwarded original args (e.g. ' %s %b')
  const origFormatStr = origArgFormatSpecs.map(s => ' ' + s).join('');

  // run_N has threadId as first arg + forwarded original args
  const runThreadArgId = uid();
  const runThreadArgName = confusableName(30);
  const runProccode = confusableName(40) + ' %s' + origFormatStr;
  const runArgIds: string[] = [runThreadArgId, ...origArgNames.map(() => uid())];
  const runArgNames: string[] = [runThreadArgName, ...origArgNames];

  // step_N has thread ID + forwarded original args (same names so body reporters resolve)
  const stepProccode = confusableName(40) + ' %s' + origFormatStr;
  const stepArgIds = [stepThreadArgId, ...origArgNames.map(() => uid())];
  const stepArgNames = [stepThreadArgName, ...origArgNames];

  const cachedPcVarName = confusableName();
  const cachedPcVarId = bb.createVariable(cachedPcVarName, 0);
  const keepGoingVarName = confusableName();
  const keepGoingVarId = bb.createVariable(keepGoingVarName, 0);
  const baseIndexVarName = confusableName();
  const baseIndexVarId = bb.createVariable(baseIndexVarName, 0);
  return {
    lists,
    runProccode, runArgIds, runArgNames,
    runArgTypes: origArgFormatSpecs.map(s => s.replace('%', '')),
    stepProccode, stepArgIds, stepArgNames,
    cachedPcVarName, cachedPcVarId,
    keepGoingVarName, keepGoingVarId,
    baseIndexVarName, baseIndexVarId,
  };
}

// ── Build run_N function ──────────────────────────────────────────
//
//   run_N(threadId, args...) [NOT warp]:
//     add (threadId) to [pcIds]
//     add (ENTRY_PC) to [pcVals]
//     [if wait infra: add 0 to waitFlags, add '' to bcastPendingMsg]
//     repeat until (item (item# of threadId in pcIds) of pcVals) = 0:
//       call step_N(threadId, args...)
//     [cleanup: delete entries from all parallel lists]

function buildRunFunction(
  target: SB3Target, bb: BlockBuilder,
  ctx: ScriptCFFContext, entryPc: number, config: ObfuscatorConfig,
): void {
  const { definitionId } = bb.procedureDefinition(
    ctx.runProccode, ctx.runArgNames, ctx.runArgIds, false, null,
  );

  const fullChain: string[] = [];

  // ── Add one entry to each parallel list ──
  const idRead1 = bb.argumentReporter(ctx.runArgNames[0]);
  const addId = bb.addToList(ctx.lists.pcIdName, ctx.lists.pcIdId, idRead1);
  bb.setParent(idRead1, addId);
  fullChain.push(addId);

  const entryLit = bb.numberLiteral(entryPc);
  _pcBlockIds.add(entryLit);
  const addPc = bb.addToList(ctx.lists.pcValName, ctx.lists.pcValId, entryLit);
  fullChain.push(addPc);

  if (ctx.lists.hasTimerWait || ctx.lists.hasBroadcastWait) {
    const zeroLit1 = bb.numberLiteral(0);
    const addWait = bb.addToList(ctx.lists.waitFlagName, ctx.lists.waitFlagId, zeroLit1);
    fullChain.push(addWait);

    const emptyStrLit = bb.textLiteral('');
    const addBcMsg = bb.addToList(ctx.lists.bcastPendingMsgName, ctx.lists.bcastPendingMsgId, emptyStrLit);
    fullChain.push(addBcMsg);
  }

  // ── Main loop body: ONLY call step_N(threadId arg, forwarded args...) ──
  const stepInputs: string[] = [bb.argumentReporter(ctx.runArgNames[0])];
  // Forward original args (skip index 0 which is threadId in run_N)
  for (let i = 1; i < ctx.runArgNames.length; i++) {
    const isBoolean = ctx.runArgTypes[i - 1] === 'b';
    stepInputs.push(isBoolean
      ? bb.argumentReporterBoolean(ctx.runArgNames[i])
      : bb.argumentReporter(ctx.runArgNames[i]));
  }
  const callStep = bb.procedureCall(
    ctx.stepProccode, ctx.stepArgIds, stepInputs, false,
  );
  for (const inp of stepInputs) {
    bb.setParent(inp, callStep);
  }

  // ── Loop exit condition: read PC directly from pcVals list (thread-safe) ──
  const tidForExit = bb.argumentReporter(ctx.runArgNames[0]);
  const idxForExit = bb.itemNumOfList(ctx.lists.pcIdName, ctx.lists.pcIdId, tidForExit);
  bb.setParent(tidForExit, idxForExit);
  const pcForExit = bb.itemOfList(ctx.lists.pcValName, ctx.lists.pcValId, idxForExit);
  bb.setParent(idxForExit, pcForExit);
  const zeroLitExit = bb.numberLiteral(0);
  const exitCond = bb.comparison('operator_equals', pcForExit, zeroLitExit);
  bb.setParent(pcForExit, exitCond);

  const loopId = bb.repeatUntil(exitCond, callStep);
  bb.setParent(exitCond, loopId);
  bb.setParent(callStep, loopId);
  fullChain.push(loopId);

  // ── Cleanup: delete one entry from pcIds, pcVals [, waitFlags, bcastPendingMsg] ──
  const idReadCleanup = bb.argumentReporter(ctx.runArgNames[0]);
  const idxCleanup = bb.itemNumOfList(ctx.lists.pcIdName, ctx.lists.pcIdId, idReadCleanup);
  bb.setParent(idReadCleanup, idxCleanup);
  const setBase = bb.setVariableToBlock(ctx.baseIndexVarName, ctx.baseIndexVarId, idxCleanup);
  bb.setParent(idxCleanup, setBase);
  fullChain.push(setBase);

  const baseR1 = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
  const delId = bb.deleteOfList(ctx.lists.pcIdName, ctx.lists.pcIdId, baseR1);
  bb.setParent(baseR1, delId);
  fullChain.push(delId);

  const baseR2 = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
  const delVal = bb.deleteOfList(ctx.lists.pcValName, ctx.lists.pcValId, baseR2);
  bb.setParent(baseR2, delVal);
  fullChain.push(delVal);

  if (ctx.lists.hasTimerWait || ctx.lists.hasBroadcastWait) {
    const baseR3 = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
    const delWait = bb.deleteOfList(ctx.lists.waitFlagName, ctx.lists.waitFlagId, baseR3);
    bb.setParent(baseR3, delWait);
    fullChain.push(delWait);

    const baseR4 = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
    const delBcMsg = bb.deleteOfList(ctx.lists.bcastPendingMsgName, ctx.lists.bcastPendingMsgId, baseR4);
    bb.setParent(baseR4, delBcMsg);
    fullChain.push(delBcMsg);
  }

  // ── Chain everything ──
  for (let i = 0; i < fullChain.length - 1; i++) {
    bb.setNext(fullChain[i], fullChain[i + 1]);
    bb.setParent(fullChain[i + 1], fullChain[i]);
  }
  const defBlock = bb.getFullBlock(definitionId)!;
  defBlock.next = fullChain[0];
  bb.setParent(fullChain[0], definitionId);
}

// ── Build step_N function ─────────────────────────────────────────
//
//   step_N(id) [WARP]:
//     set [keepGoing] to 1
//     set [baseIndex] to (item# of (id) in [pcIds])
//     repeat until (keepGoing = 0):
//       set [keepGoing] to 0
//       set [cachedPc] to (item (baseIndex) of [pcVals])
//       [BST dispatch]

function buildStepFunction(
  target: SB3Target, bb: BlockBuilder,
  ctx: ScriptCFFContext, states: CFGState[],
  config: ObfuscatorConfig, yieldRedirects: Map<number, number>,
): void {
  const { definitionId } = bb.procedureDefinition(
    ctx.stepProccode, ctx.stepArgNames, ctx.stepArgIds, true, null,
  );

  // Set keepGoing=1 at the very start (runs in warp, so no tick wasted)
  const initKG = bb.setVariable(ctx.keepGoingVarName, ctx.keepGoingVarId, 1);

  // Compute baseIndex = item# of (id) in pcIds
  const idArgBase = bb.argumentReporter(ctx.stepArgNames[0]);
  const itemNumBase = bb.itemNumOfList(ctx.lists.pcIdName, ctx.lists.pcIdId, idArgBase);
  bb.setParent(idArgBase, itemNumBase);
  const setBaseIdx = bb.setVariableToBlock(ctx.baseIndexVarName, ctx.baseIndexVarId, itemNumBase);
  bb.setParent(itemNumBase, setBaseIdx);

  // Loop body: default keepGoing=0, cache PC, BST dispatch
  const resetKG = bb.setVariable(ctx.keepGoingVarName, ctx.keepGoingVarId, 0);

  const baseIdxRead = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
  const pcRead = bb.itemOfList(ctx.lists.pcValName, ctx.lists.pcValId, baseIdxRead);
  bb.setParent(baseIdxRead, pcRead);
  const cachePc = bb.setVariableToBlock(ctx.cachedPcVarName, ctx.cachedPcVarId, pcRead);
  bb.setParent(pcRead, cachePc);

  bb.setNext(resetKG, cachePc);
  bb.setParent(cachePc, resetKG);

  // BST dispatch
  const sorted = [...states].sort((a, b) => a.pc - b.pc);
  const bstRootId = buildBSTNode(bb, sorted, 0, sorted.length - 1, ctx, config, yieldRedirects);

  bb.setNext(cachePc, bstRootId);
  bb.setParent(bstRootId, cachePc);

  // Inner loop: repeat until keepGoing = 0
  const keepGoingRead = bb.readVariable(ctx.keepGoingVarName, ctx.keepGoingVarId);
  const zeroLit = bb.numberLiteral(0);
  const exitCond = bb.comparison('operator_equals', keepGoingRead, zeroLit);
  bb.setParent(keepGoingRead, exitCond);

  const loopId = bb.repeatUntil(exitCond, resetKG);
  bb.setParent(exitCond, loopId);
  bb.setParent(resetKG, loopId);

  // Chain: initKG → setBaseIdx → loop
  bb.setNext(initKG, setBaseIdx);
  bb.setParent(setBaseIdx, initKG);
  bb.setNext(setBaseIdx, loopId);
  bb.setParent(loopId, setBaseIdx);

  const defBlock = bb.getFullBlock(definitionId)!;
  defBlock.next = initKG;
  bb.setParent(initKG, definitionId);
}

// ── BST Node Builder ──────────────────────────────────────────────

function buildBSTNode(
  bb: BlockBuilder, sorted: CFGState[], lo: number, hi: number,
  ctx: ScriptCFFContext, config: ObfuscatorConfig,
  yieldRedirects: Map<number, number>,
): string {
  if (lo === hi) {
    return buildStateBody(bb, sorted[lo], ctx, config, yieldRedirects);
  }

  if (lo + 1 === hi) {
    const leftBody = buildStateBody(bb, sorted[lo], ctx, config, yieldRedirects);
    const rightBody = buildStateBody(bb, sorted[hi], ctx, config, yieldRedirects);
    const pivot = sorted[hi].pc;
    const pcReader = readPcFromList(bb, ctx);
    const pivotExpr = bb.numberLiteral(pivot);
    _pcBlockIds.add(pivotExpr);
    const condition = bb.comparison('operator_lt', pcReader, pivotExpr);
    const ifElseId = bb.controlIfElse(condition, leftBody, rightBody);
    bb.setParent(condition, ifElseId);
    bb.setParent(pcReader, condition);
    bb.setParent(pivotExpr, condition);
    bb.setParent(leftBody, ifElseId);
    bb.setParent(rightBody, ifElseId);
    return ifElseId;
  }

  const mid = Math.floor((lo + hi) / 2);
  const pivot = sorted[mid + 1].pc;
  const leftId = buildBSTNode(bb, sorted, lo, mid, ctx, config, yieldRedirects);
  const rightId = buildBSTNode(bb, sorted, mid + 1, hi, ctx, config, yieldRedirects);
  const pcReader = readPcFromList(bb, ctx);
  const pivotExpr = bb.numberLiteral(pivot);
  _pcBlockIds.add(pivotExpr);
  const condition = bb.comparison('operator_lt', pcReader, pivotExpr);
  const ifElseId = bb.controlIfElse(condition, leftId, rightId);
  bb.setParent(condition, ifElseId);
  bb.setParent(pcReader, condition);
  bb.setParent(pivotExpr, condition);
  bb.setParent(leftId, ifElseId);
  bb.setParent(rightId, ifElseId);
  return ifElseId;
}

// ── Build the body of a single state ──────────────────────────────

function buildStateBody(
  bb: BlockBuilder, state: CFGState,
  ctx: ScriptCFFContext, config: ObfuscatorConfig,
  yieldRedirects: Map<number, number>,
): string {
  const blocks: string[] = [];

  if (state.branch) {
    // ── Branch state (if/if-else/repeat-until/wait-until) ──
    const condId = state.branch.conditionBlockId;
    const { firstBlock: setTrue } = resolveAndWritePc(bb, ctx, state.branch.truePc, yieldRedirects, state.pc, config);
    const { firstBlock: setFalse } = resolveAndWritePc(bb, ctx, state.branch.falsePc, yieldRedirects, state.pc, config);

    if (condId) {
      const ifElseId = bb.controlIfElse(condId, setTrue, setFalse);
      bb.setParent(condId, ifElseId);
      bb.setParent(setTrue, ifElseId);
      bb.setParent(setFalse, ifElseId);
      blocks.push(ifElseId);
    } else {
      blocks.push(setFalse);
    }

  } else if (state.repeatInit) {
    // ── Repeat init: store counter in KV store ──
    const ri = state.repeatInit;

    // Build key = join(threadId, join(" ", loopStaticId))
    const keyBlock = buildCounterKey(bb, ctx, ri.loopStaticId);

    // Ceil the count expression
    const countExpr = ri.countExprBlockId;
    const mathRound = bb.createBlock({
      opcode: 'operator_mathop',
      inputs: { NUM: [INPUT_SAME_BLOCK_SHADOW, countExpr] },
      fields: { OPERATOR: ['ceiling', null] },
    });
    if (countExpr) bb.setParent(countExpr, mathRound);

    // Add key to counterKeys
    const addKey = bb.addToList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyBlock);
    bb.setParent(keyBlock, addKey);
    blocks.push(addKey);

    // Add ceil(count) to counterVals
    const addVal = bb.addToList(ctx.lists.counterValName, ctx.lists.counterValId, mathRound);
    bb.setParent(mathRound, addVal);
    blocks.push(addVal);

    // Transition to check state
    const { firstBlock } = resolveAndWritePc(bb, ctx, state.nextPc, yieldRedirects, state.pc, config);
    blocks.push(firstBlock);

  } else if (state.repeatCheck) {
    // ── Repeat check: read counter, branch ──
    const rc = state.repeatCheck;

    // Build key for lookup
    const keyBlock = buildCounterKey(bb, ctx, rc.loopStaticId);

    // Find index in counterKeys
    const counterIdx = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyBlock);
    bb.setParent(keyBlock, counterIdx);

    // Read counter value
    const counterVal = bb.itemOfList(ctx.lists.counterValName, ctx.lists.counterValId, counterIdx);
    bb.setParent(counterIdx, counterVal);

    // Condition: counter > 0
    const zeroLit = bb.numberLiteral(0);
    const isPositive = bb.comparison('operator_gt', counterVal, zeroLit);
    bb.setParent(counterVal, isPositive);

    // ── True branch: decrement counter, go to body ──
    // Rebuild key for true branch (need fresh block instances)
    const keyBlock2 = buildCounterKey(bb, ctx, rc.loopStaticId);
    const counterIdx2 = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyBlock2);
    bb.setParent(keyBlock2, counterIdx2);

    // Read current value for decrement
    const keyBlock2b = buildCounterKey(bb, ctx, rc.loopStaticId);
    const counterIdx2b = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyBlock2b);
    bb.setParent(keyBlock2b, counterIdx2b);
    const counterRead = bb.itemOfList(ctx.lists.counterValName, ctx.lists.counterValId, counterIdx2b);
    bb.setParent(counterIdx2b, counterRead);
    const oneLit = bb.numberLiteral(1);
    const decremented = bb.mathOp('operator_subtract', counterRead, oneLit);
    bb.setParent(counterRead, decremented);

    // Replace counter value with decremented
    const replaceDecr = bb.replaceItemOfList(
      ctx.lists.counterValName, ctx.lists.counterValId,
      counterIdx2, decremented,
    );
    bb.setParent(counterIdx2, replaceDecr);
    bb.setParent(decremented, replaceDecr);

    // Set PC to body
    const { firstBlock: setPcBody } = resolveAndWritePc(bb, ctx, rc.bodyPc, yieldRedirects, state.pc, config);
    bb.setNext(replaceDecr, setPcBody);
    bb.setParent(setPcBody, replaceDecr);

    // ── False branch: delete counter entry, go to exit ──
    // IMPORTANT: compute index ONCE before deleting from counterKeys,
    // because deleting from counterKeys first would make the second lookup fail.
    const keyBlock3 = buildCounterKey(bb, ctx, rc.loopStaticId);
    const counterIdx3 = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyBlock3);
    bb.setParent(keyBlock3, counterIdx3);

    // Save index to a temp variable so we can use it for both deletions
    const counterCleanupVarName = confusableName();
    const counterCleanupVarId = bb.createVariable(counterCleanupVarName, 0);
    const saveIdx = bb.setVariableToBlock(counterCleanupVarName, counterCleanupVarId, counterIdx3);
    bb.setParent(counterIdx3, saveIdx);

    // Delete from counterKeys using saved index
    const savedIdx1 = bb.readVariable(counterCleanupVarName, counterCleanupVarId);
    const delKey = bb.deleteOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, savedIdx1);
    bb.setParent(savedIdx1, delKey);

    // Delete from counterVals using saved index
    const savedIdx2 = bb.readVariable(counterCleanupVarName, counterCleanupVarId);
    const delVal = bb.deleteOfList(ctx.lists.counterValName, ctx.lists.counterValId, savedIdx2);
    bb.setParent(savedIdx2, delVal);

    const { firstBlock: setPcExit } = resolveAndWritePc(bb, ctx, rc.exitPc, yieldRedirects, state.pc, config);
    bb.chain(saveIdx, delKey, delVal, setPcExit);

    // if-else
    const ifElseId = bb.controlIfElse(isPositive, replaceDecr, saveIdx);
    bb.setParent(isPositive, ifElseId);
    bb.setParent(replaceDecr, ifElseId);
    bb.setParent(saveIdx, ifElseId);
    blocks.push(ifElseId);

  } else if (state.forEachInit) {
    // ── For-each init: store bound (ceil N) and counter (0) in KV store ──
    const fi = state.forEachInit;

    // Store bound = ceil(VALUE)
    const keyBound = buildCounterKey(bb, ctx, fi.loopBoundStaticId);
    const addKeyBound = bb.addToList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyBound);
    bb.setParent(keyBound, addKeyBound);
    blocks.push(addKeyBound);

    const ceilExpr = bb.createBlock({
      opcode: 'operator_mathop',
      inputs: { NUM: [INPUT_SAME_BLOCK_SHADOW, fi.valueExprBlockId] },
      fields: { OPERATOR: ['ceiling', null] },
    });
    if (fi.valueExprBlockId) bb.setParent(fi.valueExprBlockId, ceilExpr);
    const addBound = bb.addToList(ctx.lists.counterValName, ctx.lists.counterValId, ceilExpr);
    bb.setParent(ceilExpr, addBound);
    blocks.push(addBound);

    // Store counter = 0 (0-based; first iteration sets v = 0+1 = 1)
    const keyCounter = buildCounterKey(bb, ctx, fi.loopCounterStaticId);
    const addKeyCounter = bb.addToList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyCounter);
    bb.setParent(keyCounter, addKeyCounter);
    blocks.push(addKeyCounter);

    const zeroLit = bb.numberLiteral(0);
    const addCounter = bb.addToList(ctx.lists.counterValName, ctx.lists.counterValId, zeroLit);
    blocks.push(addCounter);

    // Immediately transition to checkPc (keepGoing=1, no yield)
    const { firstBlock } = resolveAndWritePc(bb, ctx, state.nextPc, yieldRedirects, state.pc, config);
    blocks.push(firstBlock);

  } else if (state.forEachCheck) {
    // ── For-each check: if counter < bound → increment, set var, body; else cleanup + exit ──
    const fc = state.forEachCheck;

    // Read current counter value
    const keyCounterR = buildCounterKey(bb, ctx, fc.loopCounterStaticId);
    const idxCounterR = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyCounterR);
    bb.setParent(keyCounterR, idxCounterR);
    const counterVal = bb.itemOfList(ctx.lists.counterValName, ctx.lists.counterValId, idxCounterR);
    bb.setParent(idxCounterR, counterVal);

    // Read current bound value
    const keyBoundR = buildCounterKey(bb, ctx, fc.loopBoundStaticId);
    const idxBoundR = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyBoundR);
    bb.setParent(keyBoundR, idxBoundR);
    const boundVal = bb.itemOfList(ctx.lists.counterValName, ctx.lists.counterValId, idxBoundR);
    bb.setParent(idxBoundR, boundVal);

    // Condition: counter < bound
    const isLess = bb.comparison('operator_lt', counterVal, boundVal);
    bb.setParent(counterVal, isLess);
    bb.setParent(boundVal, isLess);

    // ── True branch: newCounter = counter+1, update KV, set variable, go to body ──

    // Index for the replace operation (fresh key lookup)
    const keyCounterT = buildCounterKey(bb, ctx, fc.loopCounterStaticId);
    const idxCounterT = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyCounterT);
    bb.setParent(keyCounterT, idxCounterT);

    // Read counter again (fresh) and add 1
    const keyCounterTb = buildCounterKey(bb, ctx, fc.loopCounterStaticId);
    const idxCounterTb = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyCounterTb);
    bb.setParent(keyCounterTb, idxCounterTb);
    const counterCur = bb.itemOfList(ctx.lists.counterValName, ctx.lists.counterValId, idxCounterTb);
    bb.setParent(idxCounterTb, counterCur);
    const oneLitT = bb.numberLiteral(1);
    const newCounterExpr = bb.mathOp('operator_add', counterCur, oneLitT);
    bb.setParent(counterCur, newCounterExpr);

    // Store new counter in a temp var so it can be used twice (replace + set variable)
    const newCtrVarName = confusableName();
    const newCtrVarId = bb.createVariable(newCtrVarName, 0);
    const setNewCtr = bb.setVariableToBlock(newCtrVarName, newCtrVarId, newCounterExpr);
    bb.setParent(newCounterExpr, setNewCtr);

    // Replace KV counter entry with new value
    const newCtrRead1 = bb.readVariable(newCtrVarName, newCtrVarId);
    const replaceCounter = bb.replaceItemOfList(
      ctx.lists.counterValName, ctx.lists.counterValId,
      idxCounterT, newCtrRead1,
    );
    bb.setParent(idxCounterT, replaceCounter);
    bb.setParent(newCtrRead1, replaceCounter);

    // Set the for-each variable to the new counter value
    const newCtrRead2 = bb.readVariable(newCtrVarName, newCtrVarId);
    const setVarBlock = bb.setVariableToBlock(fc.varName, fc.varId || '', newCtrRead2);
    bb.setParent(newCtrRead2, setVarBlock);

    // Transition to body (non-yielding so body starts in same warp tick)
    const { firstBlock: setPcBody } = resolveAndWritePc(bb, ctx, fc.bodyPc, yieldRedirects, state.pc, config);
    bb.chain(setNewCtr, replaceCounter, setVarBlock, setPcBody);

    // ── False branch: delete counter + bound KV entries, go to exit ──

    // Delete counter entry (compute index, save to temp, delete key+val)
    const keyCounterF = buildCounterKey(bb, ctx, fc.loopCounterStaticId);
    const idxCounterF = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyCounterF);
    bb.setParent(keyCounterF, idxCounterF);
    const ctrCleanVarName = confusableName();
    const ctrCleanVarId = bb.createVariable(ctrCleanVarName, 0);
    const saveCtrIdx = bb.setVariableToBlock(ctrCleanVarName, ctrCleanVarId, idxCounterF);
    bb.setParent(idxCounterF, saveCtrIdx);
    const savedCI1 = bb.readVariable(ctrCleanVarName, ctrCleanVarId);
    const delCtrKey = bb.deleteOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, savedCI1);
    bb.setParent(savedCI1, delCtrKey);
    const savedCI2 = bb.readVariable(ctrCleanVarName, ctrCleanVarId);
    const delCtrVal = bb.deleteOfList(ctx.lists.counterValName, ctx.lists.counterValId, savedCI2);
    bb.setParent(savedCI2, delCtrVal);
    bb.chain(saveCtrIdx, delCtrKey, delCtrVal);

    // Delete bound entry (recompute index AFTER counter deletion to account for shift)
    const keyBoundF = buildCounterKey(bb, ctx, fc.loopBoundStaticId);
    const idxBoundF = bb.itemNumOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, keyBoundF);
    bb.setParent(keyBoundF, idxBoundF);
    const bndCleanVarName = confusableName();
    const bndCleanVarId = bb.createVariable(bndCleanVarName, 0);
    const saveBndIdx = bb.setVariableToBlock(bndCleanVarName, bndCleanVarId, idxBoundF);
    bb.setParent(idxBoundF, saveBndIdx);
    const savedBI1 = bb.readVariable(bndCleanVarName, bndCleanVarId);
    const delBndKey = bb.deleteOfList(ctx.lists.counterKeyName, ctx.lists.counterKeyId, savedBI1);
    bb.setParent(savedBI1, delBndKey);
    const savedBI2 = bb.readVariable(bndCleanVarName, bndCleanVarId);
    const delBndVal = bb.deleteOfList(ctx.lists.counterValName, ctx.lists.counterValId, savedBI2);
    bb.setParent(savedBI2, delBndVal);
    bb.chain(delCtrVal, saveBndIdx, delBndKey, delBndVal);

    // Transition to exit
    const { firstBlock: setPcExit } = resolveAndWritePc(bb, ctx, fc.exitPc, yieldRedirects, state.pc, config);
    bb.chain(delBndVal, setPcExit);

    // if-else dispatching the two branches
    const ifElseId = bb.controlIfElse(isLess, setNewCtr, saveCtrIdx);
    bb.setParent(isLess, ifElseId);
    bb.setParent(setNewCtr, ifElseId);
    bb.setParent(saveCtrIdx, ifElseId);
    blocks.push(ifElseId);

  } else if (state.isTerminal) {
    // ── Terminal state: cleanup + stop/delete ──
    // Delete one entry from pcIds, pcVals [, waitFlags, bcastPendingMsg]
    const baseR1 = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
    const del1 = bb.deleteOfList(ctx.lists.pcIdName, ctx.lists.pcIdId, baseR1);
    bb.setParent(baseR1, del1);
    blocks.push(del1);

    const baseR2 = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
    const del2 = bb.deleteOfList(ctx.lists.pcValName, ctx.lists.pcValId, baseR2);
    bb.setParent(baseR2, del2);
    blocks.push(del2);

    if (ctx.lists.hasTimerWait || ctx.lists.hasBroadcastWait) {
      const baseR3 = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
      const del3 = bb.deleteOfList(ctx.lists.waitFlagName, ctx.lists.waitFlagId, baseR3);
      bb.setParent(baseR3, del3);
      blocks.push(del3);

      const baseR4t = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
      const del4t = bb.deleteOfList(ctx.lists.bcastPendingMsgName, ctx.lists.bcastPendingMsgId, baseR4t);
      bb.setParent(baseR4t, del4t);
      blocks.push(del4t);
    }

    blocks.push(bb.setVariable(ctx.keepGoingVarName, ctx.keepGoingVarId, 0));
    for (const bid of state.bodyBlockIds) {
      blocks.push(bid);
    }

  } else if (state.waitStart) {
    // ── Wait start: set waitFlags=1, store duration in bcastPendingMsg, enqueue, broadcast, yield ──
    const ws = state.waitStart;

    // Store duration in bcastPendingMsg[baseIndex] (used as generic wait data)
    const baseForDur = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
    const storeDur = bb.replaceItemOfList(
      ctx.lists.bcastPendingMsgName, ctx.lists.bcastPendingMsgId,
      baseForDur, ws.durationExprBlockId,
    );
    bb.setParent(baseForDur, storeDur);
    bb.setParent(ws.durationExprBlockId, storeDur);
    blocks.push(storeDur);

    // Set waitFlags[baseIndex] = 1 (type flag: timer wait)
    const baseForFlag = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
    const oneLitFlag = bb.numberLiteral(1);
    const storeFlag = bb.replaceItemOfList(
      ctx.lists.waitFlagName, ctx.lists.waitFlagId,
      baseForFlag, oneLitFlag,
    );
    bb.setParent(baseForFlag, storeFlag);
    bb.setParent(oneLitFlag, storeFlag);
    blocks.push(storeFlag);

    // Add threadId to waitQueue
    const tidForQueue = bb.argumentReporter(ctx.stepArgNames[0]);
    const addQueue = bb.addToList(ctx.lists.waitQueueName, ctx.lists.waitQueueId, tidForQueue);
    bb.setParent(tidForQueue, addQueue);
    blocks.push(addQueue);

    // Broadcast the wait signal (handler will process the queue)
    const waitPrimId = bb.broadcastPrimitive(ctx.lists.waitBroadcastName, ctx.lists.waitBroadcastId);
    const broadcastSignal = bb.createBlock({
      opcode: 'event_broadcast',
      inputs: { BROADCAST_INPUT: [INPUT_SAME_BLOCK_SHADOW, waitPrimId] },
    });
    bb.setParent(waitPrimId, broadcastSignal);
    blocks.push(broadcastSignal);

    // Write PC = pollPc and yield
    const pollPcValue = (config.cff.obfuscatePcTransitions)
      ? buildObfuscatedPcExpr(bb, ctx, state.pc, ws.pollPc)
      : bb.numberLiteral(ws.pollPc);
    collectPcBlockIds(bb.target, pollPcValue);
    const setPc = writePcToList(bb, ctx, pollPcValue);
    blocks.push(setPc);

    // Set cachedPcVar for step exit check (non-zero → keep looping)
    const setCached = bb.setVariable(ctx.cachedPcVarName, ctx.cachedPcVarId, ws.pollPc);
    blocks.push(setCached);
    // keepGoing stays 0 → yields

  } else if (state.broadcastWaitStart) {
    // ── Broadcast-and-wait start: store msg, set waitFlags=-1, enqueue, broadcast signal, yield ──
    const bws = state.broadcastWaitStart;

    // replace bcastPendingMsg[baseIndex] with the broadcast message expression
    const baseForMsg = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
    const storeMsg = bb.replaceItemOfList(
      ctx.lists.bcastPendingMsgName, ctx.lists.bcastPendingMsgId,
      baseForMsg, bws.broadcastExprBlockId,
    );
    bb.setParent(baseForMsg, storeMsg);
    bb.setParent(bws.broadcastExprBlockId, storeMsg);
    blocks.push(storeMsg);

    // replace waitFlags[baseIndex] with -1 (broadcast-and-wait pending)
    const baseForFlag = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
    const negOneLit = bb.numberLiteral(-1);
    const storeFlag = bb.replaceItemOfList(
      ctx.lists.waitFlagName, ctx.lists.waitFlagId,
      baseForFlag, negOneLit,
    );
    bb.setParent(baseForFlag, storeFlag);
    bb.setParent(negOneLit, storeFlag);
    blocks.push(storeFlag);

    // Add threadId to waitQueue
    const tidForQueue = bb.argumentReporter(ctx.stepArgNames[0]);
    const addQueue = bb.addToList(ctx.lists.waitQueueName, ctx.lists.waitQueueId, tidForQueue);
    bb.setParent(tidForQueue, addQueue);
    blocks.push(addQueue);

    // Broadcast the wait signal
    const waitPrimId = bb.broadcastPrimitive(ctx.lists.waitBroadcastName, ctx.lists.waitBroadcastId);
    const broadcastSignal = bb.createBlock({
      opcode: 'event_broadcast',
      inputs: { BROADCAST_INPUT: [INPUT_SAME_BLOCK_SHADOW, waitPrimId] },
    });
    bb.setParent(waitPrimId, broadcastSignal);
    blocks.push(broadcastSignal);

    // Write PC = pollPc and yield
    const pollPcValue = (config.cff.obfuscatePcTransitions)
      ? buildObfuscatedPcExpr(bb, ctx, state.pc, bws.pollPc)
      : bb.numberLiteral(bws.pollPc);
    collectPcBlockIds(bb.target, pollPcValue);
    const setPc = writePcToList(bb, ctx, pollPcValue);
    blocks.push(setPc);

    // Set cachedPcVar for step exit check
    const setCached = bb.setVariable(ctx.cachedPcVarName, ctx.cachedPcVarId, bws.pollPc);
    blocks.push(setCached);
    // keepGoing stays 0 → yields

  } else if (state.waitPoll) {
    // ── Wait poll: check if handler has cleared waitFlags to 0 ──
    // (unified for both timer waits and broadcast-and-wait)
    const wp = state.waitPoll;

    const baseForFlag = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
    const flagRead = bb.itemOfList(ctx.lists.waitFlagName, ctx.lists.waitFlagId, baseForFlag);
    bb.setParent(baseForFlag, flagRead);
    const zeroLitCond = bb.numberLiteral(0);
    const flagDone = bb.comparison('operator_equals', flagRead, zeroLitCond);
    bb.setParent(flagRead, flagDone);

    // True branch: wait done → resolve PC and continue
    const isRedirect = yieldRedirects.has(wp.continuationPc);
    const resolvedCont = isRedirect ? yieldRedirects.get(wp.continuationPc)! : wp.continuationPc;
    const shouldYield = isRedirect || resolvedCont === EXIT_PC;

    const contPcValue = (config.cff.obfuscatePcTransitions)
      ? buildObfuscatedPcExpr(bb, ctx, state.pc, resolvedCont)
      : bb.numberLiteral(resolvedCont);
    collectPcBlockIds(bb.target, contPcValue);
    const setPcContinue = writePcToList(bb, ctx, contPcValue);

    if (shouldYield) {
      const setCachedCont = bb.setVariable(ctx.cachedPcVarName, ctx.cachedPcVarId, resolvedCont);
      bb.setNext(setPcContinue, setCachedCont);
      bb.setParent(setCachedCont, setPcContinue);
    } else {
      const setKGCont = bb.setVariable(ctx.keepGoingVarName, ctx.keepGoingVarId, 1);
      bb.setNext(setPcContinue, setKGCont);
      bb.setParent(setKGCont, setPcContinue);
    }

    // False branch: still waiting → yield at pollPc
    const setCachedPoll = bb.setVariable(ctx.cachedPcVarName, ctx.cachedPcVarId, state.pc);

    const ifElseId = bb.controlIfElse(flagDone, setPcContinue, setCachedPoll);
    bb.setParent(flagDone, ifElseId);
    bb.setParent(setPcContinue, ifElseId);
    bb.setParent(setCachedPoll, ifElseId);
    blocks.push(ifElseId);

  } else {
    // ── Normal state: execute body, write nextPc ──
    for (const bid of state.bodyBlockIds) {
      blocks.push(bid);
    }

    const { firstBlock: setPc, yielded } = resolveAndWritePc(bb, ctx, state.nextPc, yieldRedirects, state.pc, config);
    blocks.push(setPc);

    // Dead states always yield
    if (state.isDead && !yielded) {
      blocks.push(bb.setVariable(ctx.keepGoingVarName, ctx.keepGoingVarId, 0));
    }
  }

  if (blocks.length === 0) {
    const { firstBlock } = resolveAndWritePc(bb, ctx, state.nextPc, yieldRedirects, state.pc, config);
    return firstBlock;
  }

  for (let i = 0; i < blocks.length - 1; i++) {
    bb.setNext(blocks[i], blocks[i + 1]);
    bb.setParent(blocks[i + 1], blocks[i]);
  }
  return blocks[0];
}

// ── Helper: collect block IDs for PC skip set ─────────────────────
// Recursively collects a block and all its input-descendant IDs into _pcBlockIds.

function collectPcBlockIds(target: SB3Target, blockId: string): void {
  _pcBlockIds.add(blockId);
  const entry = target.blocks[blockId];
  if (!entry || Array.isArray(entry)) return; // primitive — already added
  const block = entry as SB3Block;
  for (const inputArr of Object.values(block.inputs)) {
    for (let i = 1; i < inputArr.length; i++) {
      const val = inputArr[i];
      if (typeof val === 'string') collectPcBlockIds(target, val);
    }
  }
}

// ── Helper: build obfuscated PC expression from known current PC ──
// Instead of writing nextPc as a literal, compute it from cachedPc (which
// equals currentPc at this point) using arithmetic, making static analysis
// harder since transitions require solving expressions.

function buildObfuscatedPcExpr(
  bb: BlockBuilder, ctx: ScriptCFFContext,
  currentPc: number, nextPc: number,
): string {
  const offset = nextPc - currentPc;
  const kind = randomInt(1, 4);

  // All variants read cachedPcVar (which holds currentPc) and compute nextPc
  const readCached = () => bb.readVariable(ctx.cachedPcVarName, ctx.cachedPcVarId);

  switch (kind) {
    case 1: {
      // cachedPc + offset
      const offsetLit = bb.numberLiteral(offset);
      return bb.mathOp('operator_add', readCached(), offsetLit);
    }
    case 2: {
      // cachedPc - (-offset)  i.e. cachedPc - negOffset
      const negOffset = bb.numberLiteral(-offset);
      return bb.mathOp('operator_subtract', readCached(), negOffset);
    }
    case 3: {
      // (cachedPc + scramble) - scramble + offset
      // = cachedPc + offset but with an extra layer
      const scramble = randomInt(1000, 99999);
      const addScramble = bb.mathOp('operator_add', readCached(), scramble);
      const combined = bb.numberLiteral(scramble - offset);
      return bb.mathOp('operator_subtract', addScramble, combined);
    }
    case 4: {
      // (cachedPc * 2 + offset * 2) / 2
      // = cachedPc + offset = nextPc
      const doubled = bb.mathOp('operator_multiply', readCached(), 2);
      const addDoubledOffset = bb.mathOp('operator_add', doubled, offset * 2);
      const twoLit = bb.numberLiteral(2);
      return bb.mathOp('operator_divide', addDoubledOffset, twoLit);
    }
    default: {
      return bb.numberLiteral(nextPc);
    }
  }
}

// ── Helper: resolve yield redirect + write PC ─────────────────────

function resolveAndWritePc(
  bb: BlockBuilder, ctx: ScriptCFFContext,
  pc: number, yieldRedirects: Map<number, number>,
  currentPc?: number, config?: ObfuscatorConfig,
): { firstBlock: string; yielded: boolean } {
  const isRedirect = yieldRedirects.has(pc);
  const resolvedPc = isRedirect ? yieldRedirects.get(pc)! : pc;
  const shouldYield = isRedirect || resolvedPc === EXIT_PC;

  const pcValueBlock = (config?.cff.obfuscatePcTransitions && currentPc !== undefined)
    ? buildObfuscatedPcExpr(bb, ctx, currentPc, resolvedPc)
    : bb.numberLiteral(resolvedPc);
  collectPcBlockIds(bb.target, pcValueBlock);
  const setPc = writePcToList(bb, ctx, pcValueBlock);

  if (shouldYield) {
    // Yield: keepGoing stays 0. Update cachedPcVar for step's inner loop.
    const setCached = bb.setVariable(ctx.cachedPcVarName, ctx.cachedPcVarId, resolvedPc);
    bb.setNext(setPc, setCached);
    bb.setParent(setCached, setPc);
  } else {
    // Immediate: set keepGoing=1
    const setKG = bb.setVariable(ctx.keepGoingVarName, ctx.keepGoingVarId, 1);
    bb.setNext(setPc, setKG);
    bb.setParent(setKG, setPc);
  }

  return { firstBlock: setPc, yielded: shouldYield };
}

// ── Helper: build counter key ─────────────────────────────────────
// join(threadId, join(" ", loopStaticId))

function buildCounterKey(bb: BlockBuilder, ctx: ScriptCFFContext, loopStaticId: string): string {
  const threadIdRead = bb.argumentReporter(ctx.stepArgNames[0]);
  const spaceLit = bb.textLiteral(' ');
  const loopIdLit = bb.textLiteral(loopStaticId);

  const innerJoin = bb.createBlock({
    opcode: 'operator_join',
    inputs: {
      STRING1: [INPUT_SAME_BLOCK_SHADOW, spaceLit],
      STRING2: [INPUT_SAME_BLOCK_SHADOW, loopIdLit],
    },
  });
  bb.setParent(spaceLit, innerJoin);
  bb.setParent(loopIdLit, innerJoin);

  const outerJoin = bb.createBlock({
    opcode: 'operator_join',
    inputs: {
      STRING1: [INPUT_SAME_BLOCK_SHADOW, threadIdRead],
      STRING2: [INPUT_SAME_BLOCK_SHADOW, innerJoin],
    },
  });
  bb.setParent(threadIdRead, outerJoin);
  bb.setParent(innerJoin, outerJoin);

  return outerJoin;
}

// ── Helper: read cached PC variable ──────────────────────────────

function readPcFromList(bb: BlockBuilder, ctx: ScriptCFFContext): string {
  return bb.readVariable(ctx.cachedPcVarName, ctx.cachedPcVarId);
}

// ── Helper: write PC to pcVals[baseIndex] ────────────────────────

function writePcToList(bb: BlockBuilder, ctx: ScriptCFFContext, valueBlockId: string): string {
  const baseIdx = bb.readVariable(ctx.baseIndexVarName, ctx.baseIndexVarId);
  const replaceId = bb.replaceItemOfList(
    ctx.lists.pcValName, ctx.lists.pcValId,
    baseIdx, valueBlockId,
  );
  bb.setParent(baseIdx, replaceId);
  bb.setParent(valueBlockId, replaceId);
  return replaceId;
}

// ── Utility ───────────────────────────────────────────────────────

function randomHugeInt(): number {
  let pc: number;
  do {
    pc = Math.floor(Math.random() * (PC_MAX - PC_MIN + 1)) + PC_MIN;
  } while (pc === 0);
  return pc;
}

function createDeadCodeContext(target: SB3Target, bb: BlockBuilder, stage: SB3Target): DeadCodeContext {
  const fakeVars: { name: string; id: string }[] = [];
  const fakeLists: { name: string; id: string }[] = [];
  const fakeBroadcasts: { name: string; id: string }[] = [];

  for (const [id, [name]] of Object.entries(target.variables)) {
    fakeVars.push({ name, id });
    if (fakeVars.length >= 5) break;
  }
  for (const [id, [name]] of Object.entries(target.lists)) {
    fakeLists.push({ name, id });
    if (fakeLists.length >= 3) break;
  }
  // Collect broadcasts from the stage (where the VM looks them up)
  for (const [id, name] of Object.entries(stage.broadcasts)) {
    fakeBroadcasts.push({ name, id });
    if (fakeBroadcasts.length >= 3) break;
  }

  if (fakeVars.length === 0) {
    const vName = confusableName();
    const vId = bb.createVariable(vName, 0);
    fakeVars.push({ name: vName, id: vId });
  }
  if (fakeLists.length === 0) {
    const lName = confusableName();
    const lId = bb.createList(lName, [0]);
    fakeLists.push({ name: lName, id: lId });
  }
  if (fakeBroadcasts.length === 0) {
    const bName = confusableName();
    const bId = uid();
    stage.broadcasts[bId] = bName;
    fakeBroadcasts.push({ name: bName, id: bId });
  }

  // Create anchor variables (known init values, never modified — used for variable-based predicates)
  const anchorVars: { name: string; id: string; initValue: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const aName = confusableName();
    const initValue = randomInt(-9999, 9999);
    const aId = bb.createVariable(aName, initValue);
    anchorVars.push({ name: aName, id: aId, initValue });
  }

  return { fakeVars, fakeLists, fakeBroadcasts, anchorVars };
}
