import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node20',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: [
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
    'chalk',
    'glob',
    'openai',
    'tsx',
    'zod',
    'zod-to-json-schema',
  ],
  noExternal: [],
})
