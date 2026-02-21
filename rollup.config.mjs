import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

export default [
  // ── CLI (Node CJS, single file) ─────────────────────────────
  {
    input: 'src/cli.ts',
    output: {
      file: 'dist/cli.js',
      format: 'cjs',
      banner: '#!/usr/bin/env node',
    },
    external: [
      'jszip', 'fs', 'path', 'stream', 'zlib', 'util', 'buffer',
      'events', 'string_decoder', 'process',
    ],
    plugins: [
      typescript({ tsconfig: './tsconfig.json', declaration: false, sourceMap: false, compilerOptions: { target: 'ES2020' } }),
      resolve({ preferBuiltins: true }),
      commonjs(),
    ],
  },

  // ── Console injectable (Browser IIFE, single file) ──────────
  {
    input: 'src/console-inject.ts',
    output: {
      file: 'dist/console-obfuscator.js',
      format: 'iife',
      name: 'ScratchObfuscator',
    },
    plugins: [
      {
        name: 'browser-stubs',
        resolveId(source) {
          if (source === 'jszip' || source === './sb3' || source === '../sb3') return '\0empty';
          if (['fs', 'path', 'stream', 'zlib', 'util', 'buffer', 'events', 'string_decoder', 'process'].includes(source)) return '\0empty';
          return null;
        },
        load(id) {
          if (id === '\0empty') return 'export default {};';
          return null;
        },
      },
      typescript({ tsconfig: './tsconfig.json', declaration: false, sourceMap: false, compilerOptions: { target: 'ES2020' } }),
      resolve({ browser: true, preferBuiltins: false }),
      commonjs(),
    ],
  },
];
