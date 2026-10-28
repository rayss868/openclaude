/**
 * Coerce MCP tool arguments to the types declared in the tool's input schema.
 *
 * Models sometimes emit JSON primitives with the wrong type (e.g. `limit: "2000"`
 * instead of `limit: 2000`). MCP servers validate arguments against their schema
 * and reject such mismatches with errors like "data/limit must be number". This
 * module rewrites only the values that are unambiguous: schema-typed numbers and
 * booleans received as strings are converted; everything else passes through.
 */

type JsonSchemaProp = {
  type?: string | string[]
  properties?: Record<string, JsonSchemaProp>
  items?: JsonSchemaProp
}

function coerceValue(value: unknown, schema: JsonSchemaProp | undefined): unknown {
  if (value === null || value === undefined || !schema) {
    return value
  }

  const type = schema.type
  if (type === 'integer' || type === 'number') {
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
    return value
  }

  if (type === 'boolean') {
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  }

  if (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const props = schema.properties
    if (!props) return value
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      out[key] = coerceValue(v, props[key])
    }
    return out
  }

  if (type === 'array' && Array.isArray(value)) {
    if (!schema.items) return value
    return value.map(item => coerceValue(item, schema.items))
  }

  return value
}

export function coerceArgsToInputSchema(
  args: Record<string, unknown>,
  inputSchema: { properties?: Record<string, unknown> } | undefined,
): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object' || !inputSchema.properties) {
    return args
  }

  const props = inputSchema.properties as Record<string, JsonSchemaProp>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    out[key] = coerceValue(value, props[key])
  }
  return out
}
