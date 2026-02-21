/**
 * Fake Data Generation
 *
 * Creates fake variables, lists, and broadcasts on the stage
 * to confuse reverse engineering. These are referenced by dead code.
 */

import { SB3Project, SB3Target } from '../types';
import { ObfuscatorConfig } from '../config';
import { uid, confusableName, randomInt, randomNumber, randomBool, pickRandom } from '../uid';

export function applyFakeData(project: SB3Project, config: ObfuscatorConfig): void {
  if (!config.fakeData.enabled) return;

  const stage = project.targets.find(t => t.isStage);
  if (!stage) return;

  // ── Fake variables ──────────────────────────────────────────
  for (let i = 0; i < config.fakeData.fakeVariableCount; i++) {
    const id = uid();
    const name = confusableName(80);
    const value = randomBool()
      ? randomNumber(-10000, 10000)
      : uid(randomInt(5, 20));
    stage.variables[id] = [name, value];
  }

  // ── Fake lists ──────────────────────────────────────────────
  for (let i = 0; i < config.fakeData.fakeListCount; i++) {
    const id = uid();
    const name = confusableName(80);
    const items: (string | number)[] = [];
    const itemCount = randomInt(5, 25);
    for (let j = 0; j < itemCount; j++) {
      items.push(randomBool() ? randomNumber(-1000, 1000) : uid(randomInt(3, 12)));
    }
    stage.lists[id] = [name, items];
  }

  // ── Fake broadcasts ─────────────────────────────────────────
  for (let i = 0; i < config.fakeData.fakeBroadcastCount; i++) {
    const id = uid();
    const name = confusableName(60);
    stage.broadcasts[id] = name;
  }
}
