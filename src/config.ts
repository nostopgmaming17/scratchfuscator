export interface ObfuscatorConfig {
  /** Control Flow Flattening */
  cff: {
    enabled: boolean;
    /** Use binary search tree dispatch (O(log n)) vs linear if chain (O(n)) */
    bstDispatch: boolean;
    /** Number of fake/dead PC states to inject per flattened script */
    deadStatesPerScript: number;
    /** Minimum number of blocks in a script to flatten (scripts smaller than this are skipped) */
    minBlocksToFlatten: number;
    /** Use warp mode (run without screen refresh) for dispatcher custom blocks */
    warpDispatcher: boolean;
    /** Flatten custom block (procedure) bodies too, not just top-level scripts */
    flattenProcedures: boolean;
    /** Compute next PC from current PC using arithmetic instead of literal constants.
     *  Makes static analysis harder since PC transitions require solving expressions. */
    obfuscatePcTransitions: boolean;
  };

  /** Dead code injection */
  deadCode: {
    enabled: boolean;
    /** Probability (0-1) of injecting dead code after each block */
    probability: number;
    /** Use dynamic dead code (opaque predicates that evaluate at runtime) */
    dynamicDeadCode: boolean;
    /** Use variable-based opaque predicates referencing never-modified anchor variables.
     *  These look like runtime-dependent conditions but are provably always true/false. */
    variableBasedPredicates: boolean;
    /** Use builtin custom dead code templates (procedure calls, list ops, etc.) */
    builtinTemplates: boolean;
    /** Max depth of nested dead code (prevent exponential growth) */
    maxNestingDepth: number;
    /** Number of dead code blocks per injection point (min) */
    minChainLength: number;
    /** Number of dead code blocks per injection point (max) */
    maxChainLength: number;
  };

  /** Constant obfuscation */
  constants: {
    enabled: boolean;
    /** Split string literals into operator_join trees of substrings (runs before string list) */
    splitStrings: boolean;
    /** Depth of the operator_join split tree (1 = two pieces, 2 = up to four, etc.) */
    stringSplitDepth: number;
    /** Obfuscate string literals by moving them to a constants list */
    obfuscateStrings: boolean;
    /** Place the constants string pool on the stage (global) instead of per-sprite.
     *  Use false when using onlySprites — Scratch may clear unused stage lists on re-serialize. */
    globalStringPool: boolean;
    /** Obfuscate number literals into math expressions */
    obfuscateNumbers: boolean;
    /** Depth of math expression tree for number obfuscation */
    mathExpressionDepth: number;
    /** Equation-specific exclusion rules */
    equations: {
      /** Skip number equation obfuscation on CFF PC-transition blocks.
       *  When true, number literals involved in next-PC calculations
       *  (written by CFF's resolveAndWritePc / buildObfuscatedPcExpr) are
       *  left untouched by the equations sub-pass. Prevents double-obfuscation
       *  and potential precision issues on huge PC values. */
      skipCffPcBlocks: boolean;
      /** Skip number equation obfuscation on ALL CFF-generated blocks.
       *  When true, every number literal created by the CFF transform
       *  (dispatcher, state machine, list operations, counters, etc.)
       *  is excluded from the equations sub-pass. */
      skipCffBlocks: boolean;
      /** Skip number equation obfuscation on variable encryption blocks
       *  (the * a + b / - b / a math injected by varEncryption). */
      skipVarEncryptionBlocks: boolean;
      /** Skip number equation obfuscation on argument encryption blocks
       *  (the * a + b / - b / a math injected around procedure args). */
      skipArgEncryptionBlocks: boolean;
    };
  };

  /** Renaming */
  renaming: {
    enabled: boolean;
    /** Rename variables */
    variables: boolean;
    /** Rename procedures (custom blocks) */
    procedures: boolean;
    /** Rename procedure arguments */
    procedureArgs: boolean;
    /** Rename sprites */
    sprites: boolean;
    /** Rename costumes */
    costumes: boolean;
    /** Rename sounds */
    sounds: boolean;
    /** Rename broadcasts */
    broadcasts: boolean;
    /** Variable names to exclude from renaming */
    excludeVariables: string[];
  };

  /** Fake data generation */
  fakeData: {
    enabled: boolean;
    /** Number of fake variables to create */
    fakeVariableCount: number;
    /** Number of fake lists to create */
    fakeListCount: number;
    /** Number of fake broadcasts to create */
    fakeBroadcastCount: number;
  };

  /** Visual scrambling */
  scramble: {
    enabled: boolean;
    /** Scatter blocks to random positions */
    randomizePositions: boolean;
    /** Flip shadow flags to make blocks visually broken */
    flipShadows: boolean;
    /** Remove all comments */
    removeComments: boolean;
    /** Add random spam comments */
    addFakeComments: boolean;
    /** Number of fake comments to add per sprite */
    fakeCommentCount: number;
  };

  /** Sensing-of variable substitution */
  sensingOf: {
    enabled: boolean;
    /**
     * Transform reads of global (Stage) variables to sensing_of.
     * Uses sensing_of [varName v] of (tempVar) where tempVar = "_stage_".
     * Safe in any script type.
     */
    globals: boolean;
    /**
     * Transform reads of local (sprite-own) variables to sensing_of.
     * Uses sensing_of [varName v] of (tempVar) where tempVar = spriteName.
     * Only applied inside event_whenflagclicked scripts — safe because
     * green-flag scripts never run on clones.
     */
    locals: boolean;
    /** Probability (0–1) of transforming any individual data_variable read */
    probability: number;
  };

  /** Variable encryption (linear transform on numeric values) */
  varEncryption: {
    enabled: boolean;
    /** Variable names to exclude from encryption */
    excludeVariables: string[];
  };

  /** Anti-tamper integrity checks */
  antiTamper: {
    enabled: boolean;
    /** Inject hidden variables with magic values and verify they haven't been modified */
    hiddenVariableChecks: boolean;
    /** Use sensing_of to verify own variable names and sprite/stage name are intact */
    sensingOfSelfChecks: boolean;
    /** Redundant forever loops on each target that watch shared tamper flag variables */
    tamperFlagMonitors: boolean;
    /** Create hidden lists and verify their length and item values are unchanged */
    hiddenListChecks: boolean;
    /** Create paired variables that store each other's expected values */
    pairedVariableChecks: boolean;
    /** Each sprite verifies another sprite's sentinel variables in a ring pattern */
    crossSpriteVerification: boolean;
    /** Three variables must satisfy a*b+c=expected; can't be bypassed by zeroing them */
    mathematicalFlagChecks: boolean;
    /** Sum string lengths in the constants pool list and verify the checksum */
    stringListChecksum: boolean;
  };

  /** Broadcast obfuscation */
  broadcastObf: {
    enabled: boolean;
    /**
     * Replace BROADCAST_INPUT of event_broadcast / event_broadcastandwait with
     * a temp-variable pattern:
     *   set [tempVar] to [broadcastName or existing dynamic reporter]
     *   event_broadcast/broadcastandwait (data_variable tempVar)
     * Applies to all scripts on all targets (no green-flag restriction).
     * Runs after CFF so CFF-generated broadcasts are also transformed.
     */
    probability: number;
  };
}

// ── Presets ──────────────────────────────────────────────────────────

export const PRESET_LIGHT: ObfuscatorConfig = {
  cff: {
    enabled: false,
    bstDispatch: false,
    deadStatesPerScript: 0,
    minBlocksToFlatten: 5,
    warpDispatcher: true,
    flattenProcedures: false,
    obfuscatePcTransitions: false,
  },
  deadCode: {
    enabled: true,
    probability: 0.15,
    dynamicDeadCode: false,
    variableBasedPredicates: false,
    builtinTemplates: false,
    maxNestingDepth: 1,
    minChainLength: 1,
    maxChainLength: 2,
  },
  constants: {
    enabled: true,
    splitStrings: false,
    stringSplitDepth: 1,
    obfuscateStrings: true,
    globalStringPool: true,
    obfuscateNumbers: true,
    mathExpressionDepth: 1,
    equations: { skipCffPcBlocks: false, skipCffBlocks: false, skipVarEncryptionBlocks: false, skipArgEncryptionBlocks: false },
  },
  renaming: {
    enabled: true,
    variables: true,
    procedures: true,
    procedureArgs: true,
    sprites: true,
    costumes: true,
    sounds: false,
    broadcasts: true,
    excludeVariables: [],
  },
  fakeData: {
    enabled: true,
    fakeVariableCount: 20,
    fakeListCount: 5,
    fakeBroadcastCount: 10,
  },
  scramble: {
    enabled: false,
    randomizePositions: false,
    flipShadows: false,
    removeComments: true,
    addFakeComments: false,
    fakeCommentCount: 0,
  },
  varEncryption: {
    enabled: false,
    excludeVariables: [],
  },
  antiTamper: {
    enabled: false,
    hiddenVariableChecks: true,
    sensingOfSelfChecks: true,
    tamperFlagMonitors: true,
    hiddenListChecks: true,
    pairedVariableChecks: true,

    crossSpriteVerification: true,
    mathematicalFlagChecks: true,
    stringListChecksum: true,
  },
  sensingOf: {
    enabled: false,
    globals: true,
    locals: false,
    probability: 0.3,
  },
  broadcastObf: {
    enabled: false,
    probability: 0.3,
  },
};

export const PRESET_MEDIUM: ObfuscatorConfig = {
  cff: {
    enabled: true,
    bstDispatch: true,
    deadStatesPerScript: 2,
    minBlocksToFlatten: 4,
    warpDispatcher: true,
    flattenProcedures: false,
    obfuscatePcTransitions: true,
  },
  deadCode: {
    enabled: true,
    probability: 0.3,
    dynamicDeadCode: true,
    variableBasedPredicates: true,
    builtinTemplates: true,
    maxNestingDepth: 2,
    minChainLength: 1,
    maxChainLength: 3,
  },
  constants: {
    enabled: true,
    splitStrings: true,
    stringSplitDepth: 1,
    obfuscateStrings: true,
    globalStringPool: true,
    obfuscateNumbers: true,
    mathExpressionDepth: 1,
    equations: { skipCffPcBlocks: false, skipCffBlocks: false, skipVarEncryptionBlocks: false, skipArgEncryptionBlocks: false },
  },
  renaming: {
    enabled: true,
    variables: true,
    procedures: true,
    procedureArgs: true,
    sprites: true,
    costumes: true,
    sounds: true,
    broadcasts: true,
    excludeVariables: [],
  },
  fakeData: {
    enabled: true,
    fakeVariableCount: 50,
    fakeListCount: 15,
    fakeBroadcastCount: 25,
  },
  scramble: {
    enabled: true,
    randomizePositions: true,
    flipShadows: false,
    removeComments: true,
    addFakeComments: true,
    fakeCommentCount: 20,
  },
  varEncryption: {
    enabled: true,
    excludeVariables: [],
  },
  antiTamper: {
    enabled: false,
    hiddenVariableChecks: true,
    sensingOfSelfChecks: true,
    tamperFlagMonitors: true,
    hiddenListChecks: true,
    pairedVariableChecks: true,

    crossSpriteVerification: true,
    mathematicalFlagChecks: true,
    stringListChecksum: true,
  },
  sensingOf: {
    enabled: true,
    globals: true,
    locals: true,
    probability: 0.5,
  },
  broadcastObf: {
    enabled: true,
    probability: 0.5,
  },
};

export const PRESET_HEAVY: ObfuscatorConfig = {
  cff: {
    enabled: true,
    bstDispatch: true,
    deadStatesPerScript: 5,
    minBlocksToFlatten: 3,
    warpDispatcher: true,
    flattenProcedures: true,
    obfuscatePcTransitions: true,
  },
  deadCode: {
    enabled: true,
    probability: 0.45,
    dynamicDeadCode: true,
    variableBasedPredicates: true,
    builtinTemplates: true,
    maxNestingDepth: 2,
    minChainLength: 2,
    maxChainLength: 5,
  },
  constants: {
    enabled: true,
    splitStrings: true,
    stringSplitDepth: 2,
    obfuscateStrings: true,
    globalStringPool: true,
    obfuscateNumbers: true,
    mathExpressionDepth: 1,
    equations: { skipCffPcBlocks: false, skipCffBlocks: false, skipVarEncryptionBlocks: false, skipArgEncryptionBlocks: false },
  },
  renaming: {
    enabled: true,
    variables: true,
    procedures: true,
    procedureArgs: true,
    sprites: true,
    costumes: true,
    sounds: true,
    broadcasts: true,
    excludeVariables: [],
  },
  fakeData: {
    enabled: true,
    fakeVariableCount: 80,
    fakeListCount: 25,
    fakeBroadcastCount: 40,
  },
  scramble: {
    enabled: true,
    randomizePositions: true,
    flipShadows: false,
    removeComments: true,
    addFakeComments: true,
    fakeCommentCount: 40,
  },
  varEncryption: {
    enabled: true,
    excludeVariables: [],
  },
  antiTamper: {
    enabled: false,
    hiddenVariableChecks: true,
    sensingOfSelfChecks: true,
    tamperFlagMonitors: true,
    hiddenListChecks: true,
    pairedVariableChecks: true,

    crossSpriteVerification: true,
    mathematicalFlagChecks: true,
    stringListChecksum: true,
  },
  sensingOf: {
    enabled: true,
    globals: true,
    locals: true,
    probability: 1.0,
  },
  broadcastObf: {
    enabled: true,
    probability: 1.0,
  },
};

export const PRESET_MAX: ObfuscatorConfig = {
  cff: {
    enabled: true,
    bstDispatch: true,
    deadStatesPerScript: 10,
    minBlocksToFlatten: 2,
    warpDispatcher: true,
    flattenProcedures: true,
    obfuscatePcTransitions: true,
  },
  deadCode: {
    enabled: true,
    probability: 0.6,
    dynamicDeadCode: true,
    variableBasedPredicates: true,
    builtinTemplates: true,
    maxNestingDepth: 3,
    minChainLength: 3,
    maxChainLength: 6,
  },
  constants: {
    enabled: true,
    splitStrings: true,
    stringSplitDepth: 2,
    obfuscateStrings: true,
    globalStringPool: true,
    obfuscateNumbers: true,
    mathExpressionDepth: 2,
    equations: { skipCffPcBlocks: false, skipCffBlocks: false, skipVarEncryptionBlocks: false, skipArgEncryptionBlocks: false },
  },
  renaming: {
    enabled: true,
    variables: true,
    procedures: true,
    procedureArgs: true,
    sprites: true,
    costumes: true,
    sounds: true,
    broadcasts: true,
    excludeVariables: [],
  },
  fakeData: {
    enabled: true,
    fakeVariableCount: 100,
    fakeListCount: 40,
    fakeBroadcastCount: 60,
  },
  scramble: {
    enabled: true,
    randomizePositions: true,
    flipShadows: false,
    removeComments: true,
    addFakeComments: true,
    fakeCommentCount: 60,
  },
  varEncryption: {
    enabled: true,
    excludeVariables: [],
  },
  antiTamper: {
    enabled: false,
    hiddenVariableChecks: true,
    sensingOfSelfChecks: true,
    tamperFlagMonitors: true,
    hiddenListChecks: true,
    pairedVariableChecks: true,

    crossSpriteVerification: true,
    mathematicalFlagChecks: true,
    stringListChecksum: true,
  },
  sensingOf: {
    enabled: true,
    globals: true,
    locals: true,
    probability: 1.0,
  },
  broadcastObf: {
    enabled: true,
    probability: 1.0,
  },
};

// ── Runtime options ───────────────────────────────────────────────────

export interface ObfuscateOptions {
  /** Variable/list/broadcast names to skip renaming (merged with config.renaming.excludeVariables). */
  excludeNames?: string[];
  /** Only obfuscate these sprites by name. Takes precedence over excludeSprites.
   *  Stage is always included for shared state. If absent or empty, all sprites are obfuscated. */
  onlySprites?: string[];
  /** Skip obfuscating these sprites by name. Ignored if onlySprites is also set.
   *  Stage is always included for shared state regardless of this list. */
  excludeSprites?: string[];
}

/** Returns true if a target should be processed according to the given options. */
export function isTargetSelected(
  target: { isStage: boolean; name: string },
  opts?: ObfuscateOptions,
): boolean {
  // When onlySprites is set, only process those sprites — skip the stage
  // unless no filter is active (stage is needed for shared state by default).
  if (opts?.onlySprites?.length) return opts.onlySprites.includes(target.name);
  if (target.isStage) return true;
  if (opts?.excludeSprites?.length) return !opts.excludeSprites.includes(target.name);
  return true;
}

export const PRESETS: Record<string, ObfuscatorConfig> = {
  light: PRESET_LIGHT,
  medium: PRESET_MEDIUM,
  heavy: PRESET_HEAVY,
  max: PRESET_MAX,
};

export function mergeConfig(base: ObfuscatorConfig | string, overrides: Partial<DeepPartial<ObfuscatorConfig>>): ObfuscatorConfig {
  const resolved = typeof base === 'string' ? (PRESETS[base] || PRESET_MEDIUM) : base;
  const result = JSON.parse(JSON.stringify(resolved));
  deepMerge(result, overrides);
  return result;
}

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

function deepMerge(target: any, source: any): void {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}
