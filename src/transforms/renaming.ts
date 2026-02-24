/**
 * Renaming Transform
 *
 * Renames variables, procedures, procedure arguments, sprites,
 * costumes, sounds, and broadcasts to confusable I/l names.
 */

import {
  SB3Target, SB3Block, SB3Project, SB3Mutation,
  isSB3Block, isSB3Primitive,
  BROADCAST_PRIMITIVE, VAR_PRIMITIVE, LIST_PRIMITIVE,
  SB3Input,
} from '../types';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { confusableName } from '../uid';

export function applyRenaming(project: SB3Project, config: ObfuscatorConfig, opts?: ObfuscateOptions): void {
  if (!config.renaming.enabled) return;

  // Combine config exclusion list with any runtime excludeNames
  const excluded = new Set([
    ...config.renaming.excludeVariables.map(s => s.trim()),
    ...(opts?.excludeNames ?? []).map(s => s.trim()),
  ]);

  // ── Rename sprites ────────────────────────────────────────────
  if (config.renaming.sprites) {
    for (const target of project.targets) {
      if (target.isStage) continue;
      if (!isTargetSelected(target, opts)) continue;
      const oldName = target.name;
      const newName = confusableName(50);
      target.name = newName;

      // Update any "sensing_of" or other blocks that reference sprite by name
      for (const t of project.targets) {
        renameSpriteReferences(t, oldName, newName);
      }
    }
  }

  // ── Rename costumes ───────────────────────────────────────────
  if (config.renaming.costumes) {
    for (const target of project.targets) {
      if (target.isStage) continue; // Don't rename stage backdrops (can break "switch backdrop to")
      if (!isTargetSelected(target, opts)) continue;
      const costumeNameMap: Record<string, string> = {};
      for (const costume of target.costumes) {
        const oldName = costume.name;
        const newName = confusableName(40);
        costumeNameMap[oldName] = newName;
        costume.name = newName;
      }
      // Update costume references in blocks
      renameCostumeReferences(target, costumeNameMap);
    }
  }

  // ── Rename sounds ─────────────────────────────────────────────
  if (config.renaming.sounds) {
    for (const target of project.targets) {
      if (!isTargetSelected(target, opts)) continue;
      const soundNameMap: Record<string, string> = {};
      for (const sound of target.sounds) {
        const oldName = sound.name;
        const newName = confusableName(40);
        soundNameMap[oldName] = newName;
        sound.name = newName;
      }
      renameSoundReferences(target, soundNameMap);
    }
  }

  // ── Rename variables and lists ────────────────────────────────
  if (config.renaming.variables) {
    for (const target of project.targets) {
      // Skip non-selected targets (but references in their blocks are still updated below)
      if (!isTargetSelected(target, opts)) continue;
      // Skip renaming stage (global) variables/lists when onlySprites is set,
      // because non-selected sprites may reference them and would break.
      const skipGlobalVars = target.isStage && opts?.onlySprites?.length;

      // Variables
      const varNameMap: Record<string, string> = {}; // oldName -> newName
      const varIdMap: Record<string, string> = {};   // id -> newName
      if (!skipGlobalVars) {
        for (const [varId, varData] of Object.entries(target.variables)) {
          const oldName = varData[0];
          if (excluded.has(oldName)) continue;
          // Never rename cloud variables (3rd element is true)
          if (varData.length === 3 && varData[2] === true) continue;
          const newName = confusableName(80);
          varNameMap[oldName] = newName;
          varIdMap[varId] = newName;
          varData[0] = newName;
        }
      }

      // Lists
      const listIdMap: Record<string, string> = {};
      if (!skipGlobalVars) {
        for (const [listId, listData] of Object.entries(target.lists)) {
          const oldName = listData[0];
          if (excluded.has(oldName)) continue;
          const newName = confusableName(80);
          listIdMap[listId] = newName;
          listData[0] = newName;
        }
      }

      // Update block references in the owning target
      renameVariableReferences(target, varIdMap, listIdMap);

      // Stage variables are GLOBAL — sprites reference them via the Stage's
      // variable IDs in inline [12, name, id] primitives and data_variable fields.
      // We must update ALL targets' blocks, not just the Stage's own blocks.
      if (target.isStage) {
        for (const otherTarget of project.targets) {
          if (otherTarget === target) continue; // already done above
          if (!isTargetSelected(otherTarget, opts)) continue;
          renameVariableReferences(otherTarget, varIdMap, listIdMap);
        }
      }

      // Update monitors (the "show variable" / "show list" displays on the stage)
      renameMonitors(project, varIdMap, listIdMap);

      // Update sensing_of references in selected targets that may sense this target's variables
      for (const target2 of project.targets) {
        if (!isTargetSelected(target2, opts)) continue;
        renameSensingOfReferences(target, target2, varNameMap);
      }
    }
  }

  // ── Rename broadcasts ─────────────────────────────────────────
  if (config.renaming.broadcasts) {
    // Build a global broadcast name map
    const broadcastNameMap: Record<string, string> = {}; // oldName -> newName
    const broadcastIdMap: Record<string, string> = {};   // id -> newName

    for (const target of project.targets) {
      // Only rename broadcasts defined in selected targets
      if (!isTargetSelected(target, opts)) continue;
      for (const [bcId, bcName] of Object.entries(target.broadcasts)) {
        if (excluded.has(bcName)) continue;
        if (!broadcastNameMap[bcName]) {
          broadcastNameMap[bcName] = confusableName(60);
        }
        broadcastIdMap[bcId] = broadcastNameMap[bcName];
        target.broadcasts[bcId] = broadcastNameMap[bcName];
      }
    }

    // Update block references only in selected targets
    for (const target of project.targets) {
      if (!isTargetSelected(target, opts)) continue;
      renameBroadcastReferences(target, broadcastIdMap, broadcastNameMap);
    }
  }

  // ── Rename procedures ─────────────────────────────────────────
  if (config.renaming.procedures) {
    for (const target of project.targets) {
      if (!isTargetSelected(target, opts)) continue;
      renameProcedures(target, config);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function renameVariableReferences(
  target: SB3Target,
  varIdMap: Record<string, string>,
  listIdMap: Record<string, string>,
): void {
  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    // Handle primitives (inline variable/list references)
    if (isSB3Primitive(blockOrPrim)) {
      const prim = blockOrPrim;
      if (prim[0] === VAR_PRIMITIVE && prim.length >= 3) {
        const id = prim[2] as string;
        if (varIdMap[id]) prim[1] = varIdMap[id];
      }
      if (prim[0] === LIST_PRIMITIVE && prim.length >= 3) {
        const id = prim[2] as string;
        if (listIdMap[id]) prim[1] = listIdMap[id];
      }
      continue;
    }

    if (!isSB3Block(blockOrPrim)) continue;
    const block = blockOrPrim;

    // Update field references
    for (const [fieldName, field] of Object.entries(block.fields)) {
      if (fieldName === 'VARIABLE' && field.length >= 2 && field[1]) {
        const id = field[1];
        if (varIdMap[id]) field[0] = varIdMap[id];
      }
      if (fieldName === 'LIST' && field.length >= 2 && field[1]) {
        const id = field[1];
        if (listIdMap[id]) field[0] = listIdMap[id];
      }
    }

    // Update inline primitives in inputs
    for (const input of Object.values(block.inputs)) {
      for (let i = 1; i < input.length; i++) {
        const val = input[i];
        if (!Array.isArray(val)) continue;
        const prim = val as any[];
        if (prim[0] === VAR_PRIMITIVE && prim.length >= 3 && varIdMap[prim[2]]) {
          prim[1] = varIdMap[prim[2]];
        }
        if (prim[0] === LIST_PRIMITIVE && prim.length >= 3 && listIdMap[prim[2]]) {
          prim[1] = listIdMap[prim[2]];
        }
      }
    }
  }
}

/**
 * Renames the PROPERTY field of any `sensing_of` block in `target` that is
 * sensing a variable belonging to `origin`.
 *
 * The PROPERTY field stores the variable's display name (not its ID), so we
 * need varNameMap (oldName -> newName) rather than varIdMap (id -> newName).
 */
function renameSensingOfReferences(
  origin: SB3Target,
  target: SB3Target,
  varNameMap: Record<string, string>,
): void {
  for (const [, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    if (blockOrPrim.opcode !== 'sensing_of') continue;

    const propField = blockOrPrim.fields['PROPERTY'];
    if (!propField) continue;

    const menuBlockId = blockOrPrim.inputs['OBJECT']?.[1];
    if (typeof menuBlockId !== 'string') continue;

    const menuBlock = target.blocks[menuBlockId];
    if (!isSB3Block(menuBlock)) continue;
    if (menuBlock.opcode !== 'sensing_of_object_menu') continue;

    const menuField = menuBlock.fields['OBJECT'];
    if (!menuField) continue;

    const menuValue = menuField[0];

    // Match "_stage_" sentinel to stage target, otherwise match by sprite name
    const isMatch = origin.isStage
      ? menuValue === '_stage_'
      : menuValue === origin.name;

    if (!isMatch) continue;

    const newName = varNameMap[propField[0]];
    if (newName) propField[0] = newName;
  }
}

function renameBroadcastReferences(
  target: SB3Target,
  broadcastIdMap: Record<string, string>,
  broadcastNameMap: Record<string, string>,
): void {
  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (isSB3Primitive(blockOrPrim)) {
      const prim = blockOrPrim;
      if (prim[0] === BROADCAST_PRIMITIVE && prim.length >= 3) {
        const id = prim[2] as string;
        if (broadcastIdMap[id]) {
          prim[1] = broadcastIdMap[id];
        }
      }
      continue;
    }

    if (!isSB3Block(blockOrPrim)) continue;
    const block = blockOrPrim;

    // Fields: BROADCAST_OPTION
    const bcField = block.fields['BROADCAST_OPTION'];
    if (bcField) {
      if (bcField.length >= 2 && bcField[1] && broadcastIdMap[bcField[1]]) {
        bcField[0] = broadcastIdMap[bcField[1]];
      } else if (broadcastNameMap[bcField[0]]) {
        bcField[0] = broadcastNameMap[bcField[0]];
      }
    }

    // Inline broadcast primitives in inputs
    for (const input of Object.values(block.inputs)) {
      for (let i = 1; i < input.length; i++) {
        const val = input[i];
        if (!Array.isArray(val)) continue;
        const prim = val as any[];
        if (prim[0] === BROADCAST_PRIMITIVE && prim.length >= 3 && broadcastIdMap[prim[2]]) {
          prim[1] = broadcastIdMap[prim[2]];
        }
      }
    }
  }
}

function renameProcedures(target: SB3Target, config: ObfuscatorConfig): void {
  // Collect all procedure prototypes
  const proccodeMap: Record<string, string> = {}; // oldProccode -> newProccode
  // Keyed by prototype block ID (not proccode) so multiple procs with same-named
  // args each get the correct independent renaming.
  const argNameMaps: Record<string, Record<string, string>> = {}; // protoBlockId -> {oldArg -> newArg}

  for (const [blockId, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;
    if (blockOrPrim.opcode !== 'procedures_prototype') continue;

    const mutation = blockOrPrim.mutation;
    if (!mutation || !mutation.proccode) continue;

    const oldProccode = mutation.proccode;

    // Rename the procedure name (portion before first %s)
    const namePart = oldProccode.split('%')[0].trim();
    const newNamePart = confusableName(50);
    const newProccode = oldProccode.replace(namePart, newNamePart);
    proccodeMap[oldProccode] = newProccode;
    mutation.proccode = newProccode;

    // Rename arguments
    if (config.renaming.procedureArgs && mutation.argumentnames) {
      const argNames: string[] = JSON.parse(mutation.argumentnames);
      const argMap: Record<string, string> = {};
      const newArgNames = argNames.map(oldName => {
        const newName = confusableName(50);
        argMap[oldName] = newName;
        return newName;
      });
      mutation.argumentnames = JSON.stringify(newArgNames);
      // Key by prototype block ID so two procs sharing an arg name don't collide.
      argNameMaps[blockId] = argMap;
    }
  }

  // Update procedure calls and argument reporters
  for (const [, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;

    if (blockOrPrim.opcode === 'procedures_call' && blockOrPrim.mutation?.proccode) {
      const newProccode = proccodeMap[blockOrPrim.mutation.proccode];
      if (newProccode) {
        blockOrPrim.mutation.proccode = newProccode;
      }
    }

    // Rename argument reporter values
    if (blockOrPrim.opcode === 'argument_reporter_string_number' ||
      blockOrPrim.opcode === 'argument_reporter_boolean') {
      const valueField = blockOrPrim.fields['VALUE'];
      if (!valueField) continue;

      // Walk up the parent chain to the procedures_definition that owns this reporter,
      // then look up its prototype block ID to find the correct argMap.
      // This prevents cross-contamination when two procedures share an argument name.
      const defId = findProceduresDefinition(target, blockOrPrim.parent);
      if (!defId) continue;

      const defBlock = target.blocks[defId];
      if (!isSB3Block(defBlock)) continue;

      const protoId = defBlock.inputs['custom_block']?.[1];
      if (typeof protoId !== 'string') continue;

      const argMap = argNameMaps[protoId];
      if (!argMap) continue;

      const newName = argMap[valueField[0]];
      if (newName) valueField[0] = newName;
    }
  }
}

/**
 * Walk up the block parent chain from `startId` until a `procedures_definition`
 * block is found, then return its ID.  Returns null if none is found (the
 * reporter lives outside a custom-block body).
 */
function findProceduresDefinition(target: SB3Target, startId: string | null | undefined): string | null {
  let id: string | null | undefined = startId;
  while (id) {
    const block = target.blocks[id];
    if (!isSB3Block(block)) return null;
    if (block.opcode === 'procedures_definition') return id;
    id = block.parent ?? null;
  }
  return null;
}

// Opcodes whose fields can reference a sprite name, mapped to the specific
// field name that holds the reference.  Only these combinations are updated
// so that a variable/list whose display name happens to equal a sprite name
// is never accidentally renamed.
const SPRITE_REF_FIELDS: Record<string, string> = {
  'sensing_of_object_menu':    'OBJECT',
  'motion_goto_menu':          'TO',
  'motion_glideto_menu':       'TO',
  'motion_pointtowards_menu':  'TOWARDS',
  'sensing_distanceto_menu':   'DISTANCETOMENU',
  'sensing_touchingobjectmenu':'TOUCHINGOBJECTMENU',
  'control_create_clone_of_menu': 'CLONE_OPTION',
};

function renameSpriteReferences(target: SB3Target, oldName: string, newName: string): void {
  for (const [, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;

    const fieldName = SPRITE_REF_FIELDS[blockOrPrim.opcode];
    if (!fieldName) continue;

    const field = blockOrPrim.fields[fieldName];
    if (field && field[0] === oldName) {
      field[0] = newName;
    }
  }
}

function renameCostumeReferences(target: SB3Target, nameMap: Record<string, string>): void {
  for (const [, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;

    const costumeField = blockOrPrim.fields['COSTUME'];
    if (costumeField && nameMap[costumeField[0]]) {
      costumeField[0] = nameMap[costumeField[0]];
    }
  }
}

function renameMonitors(
  project: SB3Project,
  varIdMap: Record<string, string>,
  listIdMap: Record<string, string>,
): void {
  if (!project.monitors) return;
  for (const monitor of project.monitors) {
    if (!monitor || !monitor.params) continue;
    // Variable monitors: opcode "data_variable", id = varId, params.VARIABLE = name
    if (monitor.opcode === 'data_variable' && monitor.id && varIdMap[monitor.id]) {
      monitor.params.VARIABLE = varIdMap[monitor.id];
    }
    // List monitors: opcode "data_listcontents", id = listId, params.LIST = name
    if (monitor.opcode === 'data_listcontents' && monitor.id && listIdMap[monitor.id]) {
      monitor.params.LIST = listIdMap[monitor.id];
    }
  }
}

function renameSoundReferences(target: SB3Target, nameMap: Record<string, string>): void {
  for (const [, blockOrPrim] of Object.entries(target.blocks)) {
    if (!isSB3Block(blockOrPrim)) continue;

    const soundField = blockOrPrim.fields['SOUND_MENU'];
    if (soundField && nameMap[soundField[0]]) {
      soundField[0] = nameMap[soundField[0]];
    }
  }
}