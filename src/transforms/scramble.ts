/**
 * Visual Scrambling
 *
 * - Scatter blocks to random positions
 * - Flip shadow flags to break visual rendering
 * - Remove real comments and add fake ones
 */

import { SB3Project, SB3Target, isSB3Block } from '../types';
import { ObfuscatorConfig, ObfuscateOptions, isTargetSelected } from '../config';
import { uid, randomInt, randomNumber, randomBool, confusableName } from '../uid';

export function applyScramble(project: SB3Project, config: ObfuscatorConfig, opts?: ObfuscateOptions): void {
  if (!config.scramble.enabled) return;

  for (const target of project.targets) {
    if (!isTargetSelected(target, opts)) continue;
    // Remove comments
    if (config.scramble.removeComments) {
      target.comments = {};
      // Remove comment references from blocks
      for (const [, blockOrPrim] of Object.entries(target.blocks)) {
        if (isSB3Block(blockOrPrim) && (blockOrPrim as any).comment) {
          delete (blockOrPrim as any).comment;
        }
      }
    }

    // Randomize positions
    if (config.scramble.randomizePositions) {
      for (const [, blockOrPrim] of Object.entries(target.blocks)) {
        if (isSB3Block(blockOrPrim) && blockOrPrim.topLevel) {
          blockOrPrim.x = randomInt(10000, 100000);
          blockOrPrim.y = randomInt(-50000, 50000);
        }
      }
    }

    // Flip shadow flags (makes blocks visually glitched in Scratch editor)
    if (config.scramble.flipShadows) {
      for (const [, blockOrPrim] of Object.entries(target.blocks)) {
        if (isSB3Block(blockOrPrim) && !blockOrPrim.topLevel) {
          // Don't flip actual shadow blocks (menus, primitives) or hat blocks
          if (blockOrPrim.shadow) continue;
          // Randomly flip some non-shadow blocks to shadow
          if (randomBool()) {
            blockOrPrim.shadow = true;
          }
        }
      }
    }

    // Add fake comments
    if (config.scramble.addFakeComments) {
      const spamText = 'Obfuscated project.\n\n\n\n\n'.repeat(30);
      for (let i = 0; i < config.scramble.fakeCommentCount; i++) {
        const commentId = uid();
        target.comments[commentId] = {
          blockId: null,
          x: randomInt(-2000, 2000),
          y: randomInt(-2000, 2000),
          width: randomInt(200, 5000),
          height: randomInt(200, 5000),
          minimized: randomBool(),
          text: spamText,
        };
      }
    }
  }
}
