import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/index.ts'],
  format: ['esm'],
  dts: true,
  exports: true,
  publint: true,
  // The agent skill ships in the package (node_modules/site-to-api/skills/site-to-api/SKILL.md)
  // so projects that install from npm have it. skills/ at the repository root stays the one
  // source: `npx skills add` and the docs read it there; this copy is gitignored.
  copy: [
    { from: '../../skills/site-to-api/SKILL.md', to: 'skills/site-to-api' },
  ],
})
