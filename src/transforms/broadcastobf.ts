/**
 * Broadcast Obfuscation Transform
 *
 * Replaces BROADCAST_INPUT of event_broadcast and event_broadcastandwait
 * blocks with a temp-variable indirection pattern:
 *   1. set [tempBcastVar] to [broadcastName or existing dynamic reporter]
 *   2. event_broadcast/broadcastandwait (data_variable tempBcastVar)
 *
 * This hides the broadcast target from static analysis while preserving
 * correct runtime behaviour: the set-temp and the broadcast always execute
 * back-to-back with no yield between them.
 *
 * Applies to ALL scripts on ALL targets (no green-flag restriction).
 * Runs AFTER CFF so CFF-generated broadcasts are also transformed:
 *   - CFF startup event_broadcast [startBroadcast v]  (static case)
 *   - CFF run-function event_broadcastandwait (data_itemoflist) (dynamic case)
 *
 * Input shapes handled:
 *   Static:  [INPUT_SAME_BLOCK_SHADOW, menuId]
 *            → menuId is event_broadcast_menu with BROADCAST_OPTION field
 *   Dynamic: [INPUT_BLOCK_NO_SHADOW, reporterId]
 *            [INPUT_DIFF_BLOCK_SHADOW, reporterId, menuId]
 *            → existing reporter is moved into the set-temp VALUE
 *
 * One temp variable is created per target (lazily on first match).
 *
 * Pipeline position: after CFF (phase 3b), before dead code injection.
 */

import {
  SB3Project, SB3Target, SB3Primitive, isSB3Block,
  INPUT_SAME_BLOCK_SHADOW, INPUT_BLOCK_NO_SHADOW, INPUT_DIFF_BLOCK_SHADOW,
} from '../types';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { BlockBuilder } from '../blocks';
import { confusableName } from '../uid';

// ── Main entry point ──────────────────────────────────────────────

export function applyBroadcastObf(
  project: SB3Project,
  config: ObfuscatorConfig,
  opts?: ObfuscateOptions,
): void {
  if (!config.broadcastObf.enabled) return;

  for (const target of project.targets) {
    if (!isTargetSelected(target, opts)) continue;
    applyBroadcastObfToTarget(target, config);
  }
}

// ── Per-target pass ───────────────────────────────────────────────

function applyBroadcastObfToTarget(
  target: SB3Target,
  config: ObfuscatorConfig,
): void {
  const bb = new BlockBuilder(target);

  // One temp variable per target — created lazily on first match
  let tempVarName: string | null = null;
  let tempVarId: string | null = null;

  function ensureTempVar(): { tempVarName: string; tempVarId: string } {
    if (!tempVarName) {
      tempVarName = confusableName(50);
      tempVarId = bb.createVariable(tempVarName, '');
    }
    return { tempVarName: tempVarName!, tempVarId: tempVarId! };
  }

  // Snapshot block IDs to avoid mutating while iterating
  const candidates = Object.keys(target.blocks).filter(id => {
    const b = target.blocks[id];
    return (
      isSB3Block(b) &&
      (b.opcode === 'event_broadcast' || b.opcode === 'event_broadcastandwait') &&
      !b.topLevel
    );
  });

  for (const bcastBlockId of candidates) {
    const bcastBlock = target.blocks[bcastBlockId];
    if (!isSB3Block(bcastBlock)) continue;
    if (
      bcastBlock.opcode !== 'event_broadcast' &&
      bcastBlock.opcode !== 'event_broadcastandwait'
    ) continue;

    // Skip floating blocks (no parent means we can't insert before)
    if (!bcastBlock.parent) continue;

    // Probability filter
    if (Math.random() > config.broadcastObf.probability) continue;

    const inputArr = bcastBlock.inputs['BROADCAST_INPUT'];
    if (!inputArr) continue;

    const inputType = inputArr[0] as number;
    const { tempVarName: tvName, tempVarId: tvId } = ensureTempVar();

    if (inputType === INPUT_SAME_BLOCK_SHADOW) {
      // ── Static broadcast: [1, menuId] ────────────────────────────
      // event_broadcast_menu is a shadow block with BROADCAST_OPTION field
      const menuId = inputArr[1] as string;
      if (typeof menuId !== 'string') continue;

      const menuBlock = target.blocks[menuId];
      if (!isSB3Block(menuBlock) || menuBlock.opcode !== 'event_broadcast_menu') continue;

      const optionField = menuBlock.fields['BROADCAST_OPTION'];
      if (!optionField) continue;
      const broadcastName = optionField[0];
      if (!broadcastName) continue;

      // Create: set [tempBcastVar] to [broadcastName]
      const setTempId = bb.setVariable(tvName, tvId, broadcastName);

      // Splice setTemp into the sequence before the broadcast block
      insertBefore(target, bcastBlockId, setTempId);

      // Create a data_variable reporter that reads tempBcastVar at runtime
      const varReaderId = bb.createBlock({
        opcode: 'data_variable',
        fields: { VARIABLE: [tvName, tvId] },
        parent: bcastBlockId,
      });

      // Keep the menu shadow as fallback (editor display)
      bb.setParent(menuId, bcastBlockId);

      // Replace BROADCAST_INPUT: static → dynamic with shadow
      (bcastBlock.inputs as any)['BROADCAST_INPUT'] = [INPUT_DIFF_BLOCK_SHADOW, varReaderId, menuId];

    } else if (inputType === INPUT_BLOCK_NO_SHADOW || inputType === INPUT_DIFF_BLOCK_SHADOW) {
      // ── Dynamic broadcast: [2, reporterId] or [3, reporterId, menuId] ──
      // Move the existing reporter into the VALUE of a set-temp block
      const reporterId = inputArr[1] as string;
      if (typeof reporterId !== 'string') continue;

      const reporterBlock = target.blocks[reporterId];
      if (!isSB3Block(reporterBlock)) continue;

      const shadowId = (inputArr[2] as string | SB3Primitive | undefined);
      const hasShadow = typeof shadowId === 'string';

      // Create: set [tempBcastVar] to (existingReporter)
      const setTempId = bb.setVariableToBlock(tvName, tvId, reporterId);

      // Splice setTemp into the sequence before the broadcast block
      insertBefore(target, bcastBlockId, setTempId);

      // Re-parent existing reporter to the setTemp block
      bb.setParent(reporterId, setTempId);

      // Create a data_variable reporter for the broadcast block
      const varReaderId = bb.createBlock({
        opcode: 'data_variable',
        fields: { VARIABLE: [tvName, tvId] },
        parent: bcastBlockId,
      });

      // Replace BROADCAST_INPUT, preserving shadow if present
      if (hasShadow) {
        (bcastBlock.inputs as any)['BROADCAST_INPUT'] = [INPUT_DIFF_BLOCK_SHADOW, varReaderId, shadowId];
      } else {
        (bcastBlock.inputs as any)['BROADCAST_INPUT'] = [INPUT_BLOCK_NO_SHADOW, varReaderId];
      }
    }
  }
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

  const prevId = stackBlock.parent;

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

  // Case B: first block of a substack — stackId appears as a SUBSTACK* input value
  for (const [, inputArr] of Object.entries(prev.inputs)) {
    if (inputArr[1] === stackId) {
      (inputArr as any[])[1] = newId;
      return;
    }
  }
}

