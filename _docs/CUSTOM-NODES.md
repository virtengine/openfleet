# Custom Workflow Nodes

Bosun supports repo-local custom workflow nodes from the `custom-nodes/` directory at the repository root.

## Contract

Each custom node file must be an `.mjs` module that exports:

- `type` — unique node type name, typically prefixed with `custom.`
- `inputs` — array of input port names
- `outputs` — array of output port names
- `execute(node, ctx, engine)` — async or sync runtime implementation
- `describe()` — human-readable summary for the palette
- `schema` — optional JSON-schema-like config object; if provided, `schema.type` must be `object`

Example:

```js
export const type = "custom.my_notifier";
export const inputs = ["message"];
export const outputs = ["success", "error"];
export const schema = {
  type: "object",
  properties: {
    message: { type: "string" },
  },
  additionalProperties: true,
};

export function describe() {
  return "Send a custom notification";
}

export async function execute(node, ctx) {
  const message = String(node?.config?.message || "hello");
  ctx?.log?.(node?.id || type, `[custom-node] ${message}`, "info");
  return { success: true, port: "success", message };
}
```

## Discovery

- Built-in nodes are registered first.
- Bosun scans `custom-nodes/*.mjs` on workflow module startup.
- In dev mode, Bosun watches `custom-nodes/` and hot-reloads changed files.
- Custom nodes appear in the workflow palette with a `custom` badge.

## Validation

Invalid custom nodes are skipped with a warning instead of crashing startup. Bosun rejects:

- duplicate `type` names
- missing `execute`
- missing `describe`
- non-array `inputs` or `outputs`
- invalid `schema` shapes

## CLI scaffold

Create a starter node with:

```bash
bosun node:create my-notifier
```

That generates `custom-nodes/my-notifier.mjs` with a working scaffold.
