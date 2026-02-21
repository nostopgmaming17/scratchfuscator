// Alphanumeric only — special chars in block IDs break Scratch's SB3 serializer
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function uid(length = 32): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return result;
}

export function obfuscatorUid(): string {
  return '!obf_' + uid();
}

/** Generate an I/l confusable name of fixed length */
export function confusableName(length = 115): string {
  const usedNames = confusableName._used;
  for (let attempt = 0; attempt < 1000; attempt++) {
    let name = '';
    for (let i = 0; i < 2; i++) {
      const rand = Math.random();
      const bin = rand.toString(2);
      name += bin.replace(/1/g, 'l').replace(/0/g, 'I').replace(/\./g, '');
    }
    name = ('IlIlIIlIllIIIIIl' + name).substring(0, length);
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  // Fallback: append random suffix
  const fallback = 'IlIlIIlIllIIIIIl' + uid(length);
  usedNames.add(fallback);
  return fallback.substring(0, length);
}
confusableName._used = new Set<string>();

/** Reset the used names tracker (call between obfuscation runs) */
export function resetNames(): void {
  confusableName._used.clear();
}

export function randomNumber(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function randomInt(min: number, max: number): number {
  return Math.floor(randomNumber(min, max + 1));
}

export function randomBool(): boolean {
  return Math.random() < 0.5;
}

export function pickRandom<T>(...items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
