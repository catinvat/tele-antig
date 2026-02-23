import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'ES2022',
  sourcemap: !production,
  minify: production,
});

console.log(production ? '✅ Production build complete' : '✅ Dev build complete');
