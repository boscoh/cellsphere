import { rm } from 'node:fs/promises'

await rm('docs/assets', { recursive: true, force: true })
await rm('docs/index.html', { force: true })
