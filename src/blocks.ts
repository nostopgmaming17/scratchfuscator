import {
  SB3Block, SB3Input, SB3Target, SB3Primitive, SB3Mutation,
  INPUT_SAME_BLOCK_SHADOW, INPUT_BLOCK_NO_SHADOW, INPUT_DIFF_BLOCK_SHADOW,
  MATH_NUM_PRIMITIVE, TEXT_PRIMITIVE, BROADCAST_PRIMITIVE,
  VAR_PRIMITIVE, LIST_PRIMITIVE, isSB3Block,
} from './types';
import { uid } from './uid';

/**
 * BlockBuilder - creates Scratch blocks in SB3 JSON format and inserts them
 * into a target's block map.
 */
export class BlockBuilder {
  private blocks: Record<string, SB3Block | SB3Primitive>;
  readonly target: SB3Target;

  constructor(target: SB3Target) {
    this.target = target;
    this.blocks = target.blocks;
  }

  // ── Primitive creation ──────────────────────────────────────────

  /** Create a math_number shadow block (inline number literal) */
  numberLiteral(value: number, parent: string | null = null): string {
    const id = uid();
    this.blocks[id] = [MATH_NUM_PRIMITIVE, String(value)];
    return id;
  }

  /** Create a text shadow block (inline string literal) */
  textLiteral(value: string, parent: string | null = null): string {
    const id = uid();
    this.blocks[id] = [TEXT_PRIMITIVE, value];
    return id;
  }

  /** Create a variable reference primitive */
  variableRef(varName: string, varId: string, topLevel = false, x = 0, y = 0): string {
    const id = uid();
    if (topLevel) {
      this.blocks[id] = [VAR_PRIMITIVE, varName, varId, x, y];
    } else {
      this.blocks[id] = [VAR_PRIMITIVE, varName, varId];
    }
    return id;
  }

  /** Create a list reference primitive */
  listRef(listName: string, listId: string, topLevel = false, x = 0, y = 0): string {
    const id = uid();
    if (topLevel) {
      this.blocks[id] = [LIST_PRIMITIVE, listName, listId, x, y];
    } else {
      this.blocks[id] = [LIST_PRIMITIVE, listName, listId];
    }
    return id;
  }

  /** Create a broadcast menu primitive */
  broadcastPrimitive(name: string, broadcastId: string): string {
    const id = uid();
    this.blocks[id] = [BROADCAST_PRIMITIVE, name, broadcastId];
    return id;
  }

  // ── Full block creation ─────────────────────────────────────────

  /** Create a full block and add it to the target's blocks map */
  createBlock(opts: {
    opcode: string;
    inputs?: Record<string, SB3Input>;
    fields?: Record<string, [string] | [string, string | null]>;
    next?: string | null;
    parent?: string | null;
    shadow?: boolean;
    topLevel?: boolean;
    mutation?: SB3Mutation;
    id?: string;
    x?: number;
    y?: number;
  }): string {
    const id = opts.id || uid();
    const block: SB3Block = {
      opcode: opts.opcode,
      next: opts.next ?? null,
      parent: opts.parent ?? null,
      inputs: opts.inputs || {},
      fields: opts.fields || {},
      shadow: opts.shadow ?? false,
      topLevel: opts.topLevel ?? false,
    };
    if (opts.topLevel) {
      block.x = opts.x ?? 0;
      block.y = opts.y ?? 0;
    }
    if (opts.mutation) {
      block.mutation = opts.mutation;
    }
    this.blocks[id] = block;
    return id;
  }

  // ── Convenience: math operators ─────────────────────────────────

  /** Create a math operator (operator_add, operator_multiply, etc.) */
  mathOp(opcode: string, num1: number | string, num2: number | string, parent: string | null = null): string {
    const id = uid();
    const n1 = typeof num1 === 'number' ? this.numberLiteral(num1) : num1;
    const n2 = typeof num2 === 'number' ? this.numberLiteral(num2) : num2;
    this.createBlock({
      id,
      opcode,
      inputs: {
        NUM1: [INPUT_SAME_BLOCK_SHADOW, n1],
        NUM2: [INPUT_SAME_BLOCK_SHADOW, n2],
      },
      parent,
    });
    return id;
  }

  // ── Convenience: comparison operators ───────────────────────────

  /** Create a comparison (operator_equals, operator_lt, operator_gt) */
  comparison(opcode: string, op1: string, op2: string, parent: string | null = null): string {
    const id = uid();
    this.createBlock({
      id,
      opcode,
      inputs: {
        OPERAND1: [INPUT_SAME_BLOCK_SHADOW, op1],
        OPERAND2: [INPUT_SAME_BLOCK_SHADOW, op2],
      },
      parent,
    });
    return id;
  }

  /** Create operator_not */
  not(operand: string, parent: string | null = null): string {
    const id = uid();
    this.createBlock({
      id,
      opcode: 'operator_not',
      inputs: {
        OPERAND: [INPUT_BLOCK_NO_SHADOW, operand],
      },
      parent,
    });
    return id;
  }

  /** Create operator_and */
  and(op1: string, op2: string, parent: string | null = null): string {
    const id = uid();
    this.createBlock({
      id,
      opcode: 'operator_and',
      inputs: {
        OPERAND1: [INPUT_BLOCK_NO_SHADOW, op1],
        OPERAND2: [INPUT_BLOCK_NO_SHADOW, op2],
      },
      parent,
    });
    return id;
  }

  /** Create operator_or */
  or(op1: string, op2: string, parent: string | null = null): string {
    const id = uid();
    this.createBlock({
      id,
      opcode: 'operator_or',
      inputs: {
        OPERAND1: [INPUT_BLOCK_NO_SHADOW, op1],
        OPERAND2: [INPUT_BLOCK_NO_SHADOW, op2],
      },
      parent,
    });
    return id;
  }

  // ── Convenience: control blocks ─────────────────────────────────

  /** Create control_if */
  controlIf(condition: string, substackFirst: string | null, next: string | null = null, parent: string | null = null): string {
    const id = uid();
    const inputs: Record<string, SB3Input> = {
      CONDITION: [INPUT_BLOCK_NO_SHADOW, condition],
    };
    if (substackFirst) {
      inputs.SUBSTACK = [INPUT_BLOCK_NO_SHADOW, substackFirst];
    }
    this.createBlock({ id, opcode: 'control_if', inputs, next, parent });
    return id;
  }

  /** Create control_if_else */
  controlIfElse(
    condition: string,
    substackFirst: string | null,
    substack2First: string | null,
    next: string | null = null,
    parent: string | null = null,
  ): string {
    const id = uid();
    const inputs: Record<string, SB3Input> = {
      CONDITION: [INPUT_BLOCK_NO_SHADOW, condition],
    };
    if (substackFirst) {
      inputs.SUBSTACK = [INPUT_BLOCK_NO_SHADOW, substackFirst];
    }
    if (substack2First) {
      inputs.SUBSTACK2 = [INPUT_BLOCK_NO_SHADOW, substack2First];
    }
    this.createBlock({ id, opcode: 'control_if_else', inputs, next, parent });
    return id;
  }

  /** Create control_repeat_until */
  repeatUntil(condition: string, substackFirst: string | null, next: string | null = null, parent: string | null = null): string {
    const id = uid();
    const inputs: Record<string, SB3Input> = {
      CONDITION: [INPUT_BLOCK_NO_SHADOW, condition],
    };
    if (substackFirst) {
      inputs.SUBSTACK = [INPUT_BLOCK_NO_SHADOW, substackFirst];
    }
    this.createBlock({ id, opcode: 'control_repeat_until', inputs, next, parent });
    return id;
  }

  /** Create control_forever */
  forever(substackFirst: string | null, parent: string | null = null): string {
    const id = uid();
    const inputs: Record<string, SB3Input> = {};
    if (substackFirst) {
      inputs.SUBSTACK = [INPUT_BLOCK_NO_SHADOW, substackFirst];
    }
    this.createBlock({ id, opcode: 'control_forever', inputs, parent });
    return id;
  }

  /** Create control_stop [this script] */
  stopThisScript(parent: string | null = null, next: string | null = null): string {
    return this.createBlock({
      opcode: 'control_stop',
      fields: { STOP_OPTION: ['this script', null] },
      parent,
      next,
      mutation: { tagName: 'mutation', children: [], hasnext: next ? 'true' : 'false' },
    });
  }

  // ── Convenience: data blocks ────────────────────────────────────

  /** Create data_setvariableto */
  setVariable(varName: string, varId: string, value: string | number, parent: string | null = null, next: string | null = null): string {
    const valId = typeof value === 'number' ? this.numberLiteral(value) : this.textLiteral(value);
    return this.createBlock({
      opcode: 'data_setvariableto',
      inputs: { VALUE: [INPUT_SAME_BLOCK_SHADOW, valId] },
      fields: { VARIABLE: [varName, varId] },
      parent,
      next,
    });
  }

  /** Create data_setvariableto with a block as value */
  setVariableToBlock(varName: string, varId: string, valueBlockId: string, parent: string | null = null, next: string | null = null): string {
    return this.createBlock({
      opcode: 'data_setvariableto',
      inputs: { VALUE: [INPUT_BLOCK_NO_SHADOW, valueBlockId] },
      fields: { VARIABLE: [varName, varId] },
      parent,
      next,
    });
  }

  /** Create data_changevariableby */
  changeVariable(varName: string, varId: string, value: number, parent: string | null = null, next: string | null = null): string {
    const valId = this.numberLiteral(value);
    return this.createBlock({
      opcode: 'data_changevariableby',
      inputs: { VALUE: [INPUT_SAME_BLOCK_SHADOW, valId] },
      fields: { VARIABLE: [varName, varId] },
      parent,
      next,
    });
  }

  /** Create data_variable (reporter - reads a variable) */
  readVariable(varName: string, varId: string, parent: string | null = null): string {
    return this.createBlock({
      opcode: 'data_variable',
      fields: { VARIABLE: [varName, varId] },
      parent,
    });
  }

  /** Create data_addtolist */
  addToList(listName: string, listId: string, itemBlockId: string, parent: string | null = null, next: string | null = null): string {
    return this.createBlock({
      opcode: 'data_addtolist',
      inputs: { ITEM: [INPUT_SAME_BLOCK_SHADOW, itemBlockId] },
      fields: { LIST: [listName, listId] },
      parent,
      next,
    });
  }

  /** Create data_deletealloflist */
  deleteAllOfList(listName: string, listId: string, parent: string | null = null, next: string | null = null): string {
    return this.createBlock({
      opcode: 'data_deletealloflist',
      fields: { LIST: [listName, listId] },
      parent,
      next,
    });
  }

  /** Create data_replaceitemoflist */
  replaceItemOfList(
    listName: string, listId: string,
    indexBlockId: string, itemBlockId: string,
    parent: string | null = null, next: string | null = null,
  ): string {
    return this.createBlock({
      opcode: 'data_replaceitemoflist',
      inputs: {
        INDEX: [INPUT_SAME_BLOCK_SHADOW, indexBlockId],
        ITEM: [INPUT_SAME_BLOCK_SHADOW, itemBlockId],
      },
      fields: { LIST: [listName, listId] },
      parent,
      next,
    });
  }

  /** Create data_itemoflist (reporter) */
  itemOfList(listName: string, listId: string, indexBlockId: string, parent: string | null = null): string {
    return this.createBlock({
      opcode: 'data_itemoflist',
      inputs: { INDEX: [INPUT_SAME_BLOCK_SHADOW, indexBlockId] },
      fields: { LIST: [listName, listId] },
      parent,
    });
  }

  /** Create data_itemnumoflist (reporter) — returns 1-based index of item, or 0 if not found */
  itemNumOfList(listName: string, listId: string, itemBlockId: string, parent: string | null = null): string {
    return this.createBlock({
      opcode: 'data_itemnumoflist',
      inputs: { ITEM: [INPUT_SAME_BLOCK_SHADOW, itemBlockId] },
      fields: { LIST: [listName, listId] },
      parent,
    });
  }

  /** Create data_lengthoflist (reporter) */
  lengthOfList(listName: string, listId: string, parent: string | null = null): string {
    return this.createBlock({
      opcode: 'data_lengthoflist',
      fields: { LIST: [listName, listId] },
      parent,
    });
  }

  /** Create data_deleteoflist */
  deleteOfList(listName: string, listId: string, indexBlockId: string, parent: string | null = null, next: string | null = null): string {
    return this.createBlock({
      opcode: 'data_deleteoflist',
      inputs: { INDEX: [INPUT_SAME_BLOCK_SHADOW, indexBlockId] },
      fields: { LIST: [listName, listId] },
      parent,
      next,
    });
  }

  /** Create argument_reporter_string_number (reads a custom block parameter) */
  argumentReporter(argName: string, parent: string | null = null): string {
    return this.createBlock({
      opcode: 'argument_reporter_string_number',
      fields: { VALUE: [argName, null] },
      parent,
      shadow: false,
    });
  }

  /** Create argument_reporter_boolean (reads a boolean custom block parameter) */
  argumentReporterBoolean(argName: string, parent: string | null = null): string {
    return this.createBlock({
      opcode: 'argument_reporter_boolean',
      fields: { VALUE: [argName, null] },
      parent,
      shadow: false,
    });
  }

  /** Create control_repeat */
  controlRepeat(times: string, substackFirst: string | null, next: string | null = null, parent: string | null = null): string {
    const id = uid();
    const inputs: Record<string, SB3Input> = {
      TIMES: [INPUT_SAME_BLOCK_SHADOW, times],
    };
    if (substackFirst) {
      inputs.SUBSTACK = [INPUT_BLOCK_NO_SHADOW, substackFirst];
    }
    this.createBlock({ id, opcode: 'control_repeat', inputs, next, parent });
    return id;
  }

  /** Create control_wait */
  controlWait(duration: string, parent: string | null = null, next: string | null = null): string {
    return this.createBlock({
      opcode: 'control_wait',
      inputs: { DURATION: [INPUT_SAME_BLOCK_SHADOW, duration] },
      parent,
      next,
    });
  }

  /** Create control_wait_until */
  controlWaitUntil(condition: string, parent: string | null = null, next: string | null = null): string {
    return this.createBlock({
      opcode: 'control_wait_until',
      inputs: { CONDITION: [INPUT_BLOCK_NO_SHADOW, condition] },
      parent,
      next,
    });
  }

  // ── Convenience: event blocks ───────────────────────────────────

  /** Create event_broadcast */
  broadcast(broadcastName: string, broadcastId: string, parent: string | null = null, next: string | null = null): string {
    const menuId = this.createBlock({
      opcode: 'event_broadcast_menu',
      fields: { BROADCAST_OPTION: [broadcastName, broadcastId] },
      shadow: true,
    });
    const id = this.createBlock({
      opcode: 'event_broadcast',
      inputs: { BROADCAST_INPUT: [INPUT_SAME_BLOCK_SHADOW, menuId] },
      parent,
      next,
    });
    // set parent of menu
    this.setParent(menuId, id);
    return id;
  }

  // ── Convenience: procedures ─────────────────────────────────────

  /** Create a procedures_definition + procedures_prototype */
  procedureDefinition(
    proccode: string,
    argumentNames: string[],
    argumentIds: string[],
    warp: boolean,
    next: string | null = null,
  ): { definitionId: string; prototypeId: string } {
    const prototypeId = uid();
    const definitionId = uid();

    // Extract argument types from proccode (%s = string/number, %b = boolean)
    const argTypes: string[] = [];
    const typeRegex = /%([sb])/g;
    let typeMatch;
    while ((typeMatch = typeRegex.exec(proccode)) !== null) {
      argTypes.push(typeMatch[1]);
    }

    // Create argument reporter blocks
    const argBlockIds: string[] = [];
    for (let i = 0; i < argumentNames.length; i++) {
      const argId = argumentIds[i] || uid();
      const isBoolean = argTypes[i] === 'b';
      this.createBlock({
        id: argId,
        opcode: isBoolean ? 'argument_reporter_boolean' : 'argument_reporter_string_number',
        fields: { VALUE: [argumentNames[i], null] },
        parent: prototypeId,
        shadow: true,
      });
      argBlockIds.push(argId);
    }

    // Build inputs for prototype
    const protoInputs: Record<string, SB3Input> = {};
    for (let i = 0; i < argBlockIds.length; i++) {
      protoInputs[argBlockIds[i]] = [INPUT_SAME_BLOCK_SHADOW, argBlockIds[i]];
    }

    // Create prototype
    this.createBlock({
      id: prototypeId,
      opcode: 'procedures_prototype',
      inputs: protoInputs,
      parent: definitionId,
      shadow: true,
      mutation: {
        tagName: 'mutation',
        children: [],
        proccode,
        argumentids: JSON.stringify(argBlockIds),
        argumentnames: JSON.stringify(argumentNames),
        argumentdefaults: JSON.stringify(argTypes.map(t => t === 'b' ? 'false' : '')),
        warp: String(warp),
      },
    });

    // Create definition
    this.createBlock({
      id: definitionId,
      opcode: 'procedures_definition',
      inputs: { custom_block: [INPUT_SAME_BLOCK_SHADOW, prototypeId] },
      topLevel: true,
      next,
    });

    return { definitionId, prototypeId };
  }

  /** Create a procedures_call block */
  procedureCall(
    proccode: string,
    argumentIds: string[],
    inputBlockIds: string[],
    warp: boolean,
    parent: string | null = null,
    next: string | null = null,
  ): string {
    const inputs: Record<string, SB3Input> = {};
    for (let i = 0; i < argumentIds.length; i++) {
      inputs[argumentIds[i]] = [INPUT_SAME_BLOCK_SHADOW, inputBlockIds[i]];
    }
    return this.createBlock({
      opcode: 'procedures_call',
      inputs,
      parent,
      next,
      mutation: {
        tagName: 'mutation',
        children: [],
        proccode,
        argumentids: JSON.stringify(argumentIds),
        warp: String(warp),
      },
    });
  }

  // ── Utility ─────────────────────────────────────────────────────

  /** Get a block by ID */
  getBlock(id: string): SB3Block | SB3Primitive | undefined {
    return this.blocks[id];
  }

  /** Get a block, asserting it's a full block (not primitive) */
  getFullBlock(id: string): SB3Block | undefined {
    const b = this.blocks[id];
    if (b && isSB3Block(b)) return b;
    return undefined;
  }

  /** Set the parent of a block */
  setParent(blockId: string, parentId: string | null): void {
    const b = this.getFullBlock(blockId);
    if (b) b.parent = parentId;
  }

  /** Set the next of a block */
  setNext(blockId: string, nextId: string | null): void {
    const b = this.getFullBlock(blockId);
    if (b) b.next = nextId;
  }

  /** Delete a block by ID */
  deleteBlock(id: string): void {
    delete this.blocks[id];
  }

  /** Chain a list of block IDs together (set next/parent links) */
  chain(...blockIds: (string | null)[]): void {
    const ids = blockIds.filter(Boolean) as string[];
    for (let i = 0; i < ids.length - 1; i++) {
      this.setNext(ids[i], ids[i + 1]);
      this.setParent(ids[i + 1], ids[i]);
    }
  }

  /** Walk a chain of blocks starting from a block ID, collecting all IDs in order */
  walkChain(startId: string): string[] {
    const result: string[] = [];
    let current: string | null = startId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      result.push(current);
      const block = this.getFullBlock(current);
      if (!block) break;
      current = block.next;
    }
    return result;
  }

  /** Create a variable on the target */
  createVariable(name: string, value: string | number = 0): string {
    const id = uid();
    this.target.variables[id] = [name, value];
    return id;
  }

  /** Create a list on the target */
  createList(name: string, items: (string | number)[] = []): string {
    const id = uid();
    this.target.lists[id] = [name, items];
    return id;
  }

  /** Create a broadcast on the target's parent stage (broadcasts are global) */
  createBroadcast(name: string): string {
    const id = uid();
    this.target.broadcasts[id] = name;
    return id;
  }
}
