// Bundle the API for production. Dependencies from node_modules stay external (native modules such as
// better-sqlite3 cannot be bundled); the workspace package @merge/shared is bundled in because it ships
// TypeScript source rather than compiled JavaScript.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'externalise-node-modules',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@merge/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});
