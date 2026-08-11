import { readFile, writeFile } from 'fs/promises'
import { generateSettingsJSONSchema } from '../src/utils/settings/schemaOutput.js'

const SCHEMA_PATH = 'config/settings-schema.json'

async function schemaIsCurrent(): Promise<boolean> {
  const current = generateSettingsJSONSchema()
  const onDisk = (await readFile(SCHEMA_PATH, 'utf8')).trim()
  return current === onDisk
}

async function writeSchema(): Promise<string> {
  const schema = generateSettingsJSONSchema()
  const formatted = `${schema.trim()}\n`
  await writeFile(SCHEMA_PATH, formatted)
  return SCHEMA_PATH
}

const shouldCheck = process.argv.includes('--check')

if (shouldCheck) {
  if (await schemaIsCurrent()) {
    console.log('Settings schema is up to date.')
  } else {
    console.error(
      `Settings schema is out of date. Run \`bun run scripts/generate-settings-schema.ts\`.`,
    )
    process.exit(1)
  }
} else {
  const path = await writeSchema()
  console.log(`Wrote ${path} (${await byteLength(path)} bytes)`)
}

async function byteLength(path: string): Promise<number> {
  const content = await readFile(path, 'utf8')
  return Buffer.byteLength(content)
}