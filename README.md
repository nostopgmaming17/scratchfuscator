# scratchfuscator

Scratch project (.sb3) obfuscator with BST-dispatch control flow flattening, dead code injection, opaque predicates, constant obfuscation, broadcast obfuscation, and variable renaming.

## Install

```bash
npm install
```

## Build

```bash
npm run build        # production (minified)
npm run build:dev    # development
```

## Usage

```bash
npx scratchfuscator input.sb3 -o output.sb3
```

### CLI Options

| Flag | Description |
|------|-------------|
| `-o, --output <file>` | Output file path (default: `input.obfuscated.sb3`) |
| `-p, --preset <name>` | Obfuscation intensity: `light`, `medium`, `heavy`, `max` (default: `medium`) |
| `-c, --config <file>` | Path to custom JSON config file (overrides preset) |
| `--list-presets` | List all available presets |
| `--no-cff` | Disable control flow flattening |
| `--no-deadcode` | Disable dead code injection |
| `--no-constants` | Disable constant obfuscation |
| `--no-renaming` | Disable renaming |
| `--no-fakedata` | Disable fake data generation |
| `--no-scramble` | Disable visual scrambling |
| `--linear-dispatch` | Use linear if-chain dispatch instead of BST |
| `--dead-states <n>` | Number of dead PC states per flattened script |
| `--exclude-vars <a,b,c>` | Variable names to exclude from renaming |

## Presets

| Preset | CFF | Dead Code | Fake Data | Constants | Scramble |
|--------|-----|-----------|-----------|-----------|----------|
| `light` | off | 20% probability, depth 1 | 20 vars, 5 lists, 10 broadcasts | depth 1 | off |
| `medium` | BST, 3 dead states | 40%, depth 2, opaque predicates | 50 vars, 15 lists, 25 broadcasts | depth 2 | 20 fake comments |
| `heavy` | BST, 8 dead states, flatten procedures | 60%, depth 3 | 80 vars, 25 lists, 40 broadcasts | depth 3 | 40 fake comments |
| `max` | BST, 16 dead states, flatten procedures, obfuscate PC transitions | 75%, depth 4 | 100 vars, 40 lists, 60 broadcasts | depth 4 | 60 fake comments |

## Transforms

The obfuscator applies transforms in a fixed order. Each phase builds on the previous one.

### 1. Fake Data Generation

Creates decoy variables, lists, and broadcasts on the stage. These are never referenced in actual code but make it harder to distinguish real data from noise. Names use confusable `I`/`l` characters.

### 2. Renaming

Replaces all identifiable names with obfuscated `I`/`l`-confusable strings. Affects variables, procedures, procedure arguments, sprites, costumes, sounds, and broadcasts. Runs before CFF so that flattened code captures already-renamed names.

### 3. Sensing-of Substitution

Replaces direct variable reads (`data_variable`) with indirect `sensing_of` blocks that read through a temp variable. This hides which sprite and variable is being accessed from static analysis.

- Global variables: transformed in any script
- Local variables: only transformed in green-flag scripts (safe from clone issues)
- Configurable probability per variable read

### 4. Control Flow Flattening (CFF)

The core transform. Converts scripts into state machines with a dispatcher custom block.

- **BST dispatch**: O(log n) lookup using a binary search tree of `operator_lt` comparisons
- **Thread-safe**: each thread gets a unique random ID; PC values are large random numbers
- **Parallel list architecture**: four core lists (`pcIds`, `pcVals`, `counterKeys`, `counterVals`) track per-thread state
- **Dead states**: injects unreachable PC states filled with dead code
- **Wait handling**: queue-based mechanism for `wait` and `broadcast-and-wait` blocks
- **Warp mode**: dispatcher runs without screen refresh between state transitions

### 5. Broadcast Obfuscation

Replaces broadcast inputs with temp-variable indirection. Instead of broadcasting a literal name, sets a temp variable to the name and broadcasts that variable. Runs after CFF so CFF-generated broadcasts are also transformed.

### 6. Dead Code Injection

Injects false conditional branches with unreachable code throughout the project.

- **Static predicates**: always-false literal conditions
- **Opaque predicates**: runtime-evaluated but provably always true/false
- **Variable-based predicates**: use anchor variables with known initial values
- **Builtin templates**: realistic code patterns (procedure calls, list operations, etc.)
- Configurable probability, nesting depth, and chain length

### 7. Constant Obfuscation

Obfuscates number and string literals in three sub-passes:

1. **String splitting**: splits text into `operator_join` trees of substrings
2. **String pooling**: moves text into a global constants list, replaced with `data_itemoflist`
3. **Number equations**: replaces numeric literals with arithmetic expression trees

Splitting before pooling increases entropy since individual fragments land in the pool.

#### Equation exclusion rules

The number equations sub-pass has two CFF-aware exclusion options under `constants.equations`, both defaulting to `true`:

- **`skipCffPcBlocks`**: skips number literals involved in PC-transition calculations (next-PC values, BST pivot comparisons, entry PC). Prevents double-obfuscation and precision issues on the huge random PC values used by the state machine.
- **`skipCffBlocks`**: skips ALL number literals created by the CFF transform (dispatcher infrastructure, list operations, counters, wait handling, etc.). This is a superset of `skipCffPcBlocks` — when both are true, `skipCffBlocks` takes precedence.

### 8. Visual Scrambling

Makes the project harder to read in the Scratch editor:

- Scatters top-level blocks to random positions
- Flips block shadow flags
- Removes real comments
- Adds spam fake comments

### 9. Primitive Inlining

Automatic final pass that ensures SB3 schema compliance by inlining primitive blocks (numbers, text, colors, broadcasts) into their parent inputs.

## How It Works

1. **Load** the `.sb3` file (a ZIP containing `project.json` and media assets)
2. **Run the pipeline** through all 9 phases in order
3. **Write** the modified `project.json` back into the ZIP, preserving all media assets unchanged
4. **Output** the obfuscated `.sb3` file

## Browser Console Usage

The build also produces `dist/console-obfuscator.js`, a browser-injectable IIFE that accesses the Scratch VM's internal state via the global `vm` variable. This version has no Node.js dependencies.

## Project Structure

```
src/
  cli.ts                  CLI and argument parsing
  index.ts                Library entry points
  config.ts               Configuration and presets
  types.ts                SB3 JSON type definitions
  blocks.ts               BlockBuilder helper
  sb3.ts                  SB3 file I/O
  uid.ts                  ID generation utilities
  console-inject.ts       Browser console injectable
  transforms/
    index.ts              Pipeline orchestration
    cff.ts                Control flow flattening
    deadcode.ts           Dead code injection
    constants.ts          Constant obfuscation
    renaming.ts           Identifier renaming
    fakedata.ts           Fake data generation
    sensingof.ts          Sensing-of substitution
    broadcastobf.ts       Broadcast obfuscation
    scramble.ts           Visual scrambling
```
