// ── SB3 Project JSON types ──────────────────────────────────────────

export interface SB3Project {
  targets: SB3Target[];
  monitors: any[];
  extensions: string[];
  meta: { semver: string; vm: string; agent: string };
  /** Block IDs of CFF PC-transition primitives/operators. Populated by CFF, consumed by constants pass. */
  _cffPcBlockIds?: Set<string>;
  /** All block IDs created by the CFF transform. Populated by pipeline, consumed by constants pass. */
  _cffBlockIds?: Set<string>;
  /** Block IDs created by the CFF wait handler (safe to obfuscate). Populated by CFF, consumed by pipeline. */
  _cffWaitHandlerBlockIds?: Set<string>;
  /** Block IDs created by the variable encryption transform. */
  _varEncBlockIds?: Set<string>;
  /** Block IDs created by the argument encryption transform. */
  _argEncBlockIds?: Set<string>;
  /** Constants string pool list info. Populated by constants transform, consumed by anti-tamper. */
  _constListInfo?: { id: string; name: string };
}

export interface SB3Target {
  isStage: boolean;
  name: string;
  variables: Record<string, SB3Variable>;   // id -> [name, value] or [name, value, true] for cloud
  lists: Record<string, SB3List>;           // id -> [name, [items...]]
  broadcasts: Record<string, string>;       // id -> name
  blocks: Record<string, SB3Block | SB3Primitive>;
  comments: Record<string, SB3Comment>;
  currentCostume: number;
  costumes: SB3Costume[];
  sounds: SB3Sound[];
  volume: number;
  layerOrder: number;
  // Stage-specific
  tempo?: number;
  videoTransparency?: number;
  videoState?: string;
  textToSpeechLanguage?: string | null;
  // Sprite-specific
  visible?: boolean;
  x?: number;
  y?: number;
  size?: number;
  direction?: number;
  draggable?: boolean;
  rotationStyle?: string;
}

// [name, value] or [name, value, true] for cloud
export type SB3Variable = [string, string | number] | [string, string | number, boolean];

// [name, [item1, item2, ...]]
export type SB3List = [string, (string | number)[]];

export interface SB3Block {
  opcode: string;
  next: string | null;
  parent: string | null;
  inputs: Record<string, SB3Input>;
  fields: Record<string, SB3Field>;
  shadow: boolean;
  topLevel: boolean;
  x?: number;
  y?: number;
  mutation?: SB3Mutation;
  comment?: string;
}

// Input: [type, blockIdOrPrimitive] or [type, blockIdOrPrimitive, shadowIdOrPrimitive]
// type 1 = INPUT_SAME_BLOCK_SHADOW (unobscured shadow)
// type 2 = INPUT_BLOCK_NO_SHADOW
// type 3 = INPUT_DIFF_BLOCK_SHADOW (obscured shadow)
export type SB3Input = [number, string | SB3Primitive | null] |
                       [number, string | SB3Primitive | null, string | SB3Primitive | null];

export const INPUT_SAME_BLOCK_SHADOW = 1;
export const INPUT_BLOCK_NO_SHADOW = 2;
export const INPUT_DIFF_BLOCK_SHADOW = 3;

// Primitive: [primitiveType, value, ?id, ?x, ?y]
// 4=math_number, 5=positive_number, 6=whole_number, 7=integer, 8=angle
// 9=color_picker, 10=text, 11=broadcast, 12=variable, 13=list
export type SB3Primitive = [number, string] |
                           [number, string, string] |
                           [number, string, string, number, number];

export const MATH_NUM_PRIMITIVE = 4;
export const POSITIVE_NUM_PRIMITIVE = 5;
export const WHOLE_NUM_PRIMITIVE = 6;
export const INTEGER_NUM_PRIMITIVE = 7;
export const ANGLE_NUM_PRIMITIVE = 8;
export const COLOR_PICKER_PRIMITIVE = 9;
export const TEXT_PRIMITIVE = 10;
export const BROADCAST_PRIMITIVE = 11;
export const VAR_PRIMITIVE = 12;
export const LIST_PRIMITIVE = 13;

// Field: [value] or [value, id]
export type SB3Field = [string] | [string, string | null];

export interface SB3Mutation {
  tagName: string;
  children: any[];
  proccode?: string;
  argumentids?: string;
  argumentnames?: string;
  argumentdefaults?: string;
  warp?: string;
  hasnext?: string;
}

export interface SB3Comment {
  blockId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  text: string;
}

export interface SB3Costume {
  name: string;
  bitmapResolution?: number;
  dataFormat: string;
  assetId: string;
  md5ext: string;
  rotationCenterX: number;
  rotationCenterY: number;
}

export interface SB3Sound {
  name: string;
  assetId: string;
  dataFormat: string;
  format?: string;
  rate: number;
  sampleCount: number;
  md5ext: string;
}

// ── VM internal block format (for console injection) ────────────────

export interface VMBlock {
  id: string;
  opcode: string;
  next: string | null;
  parent: string | null;
  inputs: Record<string, VMInput>;
  fields: Record<string, VMField>;
  shadow: boolean;
  topLevel: boolean;
  x?: number;
  y?: number;
  mutation?: SB3Mutation;
}

export interface VMInput {
  name: string;
  block: string | null;
  shadow: string | null;
}

export interface VMField {
  name: string;
  value: string;
  id?: string;
  variableType?: string;
}

// ── Helper type to check if a block entry is a primitive ────────────

export function isSB3Primitive(block: SB3Block | SB3Primitive): block is SB3Primitive {
  return Array.isArray(block);
}

export function isSB3Block(block: SB3Block | SB3Primitive): block is SB3Block {
  return !Array.isArray(block) && typeof block === 'object' && 'opcode' in block;
}
