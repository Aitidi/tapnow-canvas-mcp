import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { editOperationSchema, promptReferencesSchema, promptSetSchema } from '../dist/server.js';

// Connect to the production entry point. No canvas edits, selection changes or paid generation.
const root = fileURLToPath(new URL('../', import.meta.url));
const expected = [
  'tapnow_diagnose', 'tapnow_canvas_read', 'tapnow_canvas_edit', 'tapnow_canvas_view',
  'tapnow_asset_import', 'tapnow_generation_capabilities', 'tapnow_generation_prepare',
  'tapnow_generation_submit', 'tapnow_generation_status', 'tapnow_history',
  'tapnow_canvas_save', 'tapnow_canvas_screenshot',
  'tapnow_prompt_references', 'tapnow_prompt_set',
].sort();
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))], cwd: root, env, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += String(chunk); });
const client = new Client({ name: 'tapnow-readonly-smoke', version: '0.1.0' });
const results: Record<string, unknown> = {};
const schemaOnly = process.argv.includes('--schema-only');
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(t => t.name).sort(), expected);
  for (const tool of listed.tools) assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown fields`);
  assert.equal(listed.tools.find(t => t.name === 'tapnow_generation_prepare')?.annotations?.readOnlyHint, false);
  assert.equal(listed.tools.find(t => t.name === 'tapnow_prompt_references')?.annotations?.readOnlyHint, true);
  assert.equal(listed.tools.find(t => t.name === 'tapnow_prompt_set')?.annotations?.readOnlyHint, false);
  results.toolCount = listed.tools.length;
  let unknownFieldRejected = false;
  try {
    const invalid = await client.callTool({ name: 'tapnow_canvas_read', arguments: { eval: 'not-executable' } });
    unknownFieldRejected = invalid.isError === true;
  } catch (error) {
    assert.match(String(error), /invalid|argument|schema|eval/i);
    unknownFieldRejected = true;
  }
  assert.equal(unknownFieldRejected, true, 'a read tool must reject an unknown eval field');
  // JSON cannot encode Infinity. Validate against the exact production schema locally;
  // never call a write tool merely to exercise its input validation.
  const nonfiniteParamsRejected = !editOperationSchema.safeParse({ op: 'create', kind: 'text', data: { params: { value: Infinity } } }).success;
  assert.equal(nonfiniteParamsRejected, true, 'params must reject nonfinite numbers');
  const promptBase = { canvasId: 'schema-only-canvas', nodeId: 'target', requestId: 'schema-only-request' };
  const validPromptSegments = [
    { type: 'text', text: '参考 ' },
    { type: 'reference', source: 'canvas', nodeId: 'image-source' },
    { type: 'text', text: ' 与 ' },
    { type: 'reference', source: 'library', assetId: 'library-source' },
  ];
  assert.equal(promptSetSchema.safeParse({ ...promptBase, segments: validPromptSegments }).success, true);
  assert.equal(promptSetSchema.safeParse({ ...promptBase, segments: [{ type: 'reference', source: 'library', assetId: 'asset', url: 'https://example.com/fake.png' }] }).success, false);
  assert.equal(promptSetSchema.safeParse({ ...promptBase, segments: [{ type: 'text', text: 'a'.repeat(100001) }, { type: 'text', text: 'b'.repeat(100000) }] }).success, false);
  assert.equal(promptSetSchema.safeParse({ ...promptBase, segments: Array.from({ length: 33 }, (_, i) => ({ type: 'reference', source: 'canvas', nodeId: `source-${i}` })) }).success, false);
  assert.equal(promptSetSchema.safeParse({ ...promptBase, segments: [] }).success, false);
  assert.equal(promptReferencesSchema.safeParse({ canvasId: promptBase.canvasId, eval: 'not-executable' }).success, false);
  assert.deepEqual(promptReferencesSchema.parse({ canvasId: promptBase.canvasId }), { canvasId: promptBase.canvasId, source: 'canvas', limit: 50, offset: 0 });
  results.schemaChecks = { unknownFieldRejected, nonfiniteParamsRejected, promptSegmentsChecked: true };
  async function call(name: string, args: Record<string, unknown> = {}) {
    const value = await client.callTool({ name, arguments: args });
    assert.notEqual(value.isError, true, `${name}: ${JSON.stringify(value.structuredContent)}`);
    assert.ok(value.structuredContent && typeof value.structuredContent === 'object' && !Array.isArray(value.structuredContent), `${name} must return a structured object`);
    const structuredContent = value.structuredContent as Record<string, unknown>;
    assert.equal(structuredContent.ok, true, `${name} must return structured ok:true`);
    return { ...value, structuredContent };
  }
  if (!schemaOnly) {
    const diagnose = (await call('tapnow_diagnose')).structuredContent!;
    results.diagnose = { ok: diagnose.ok, desktop: diagnose.desktop, nativeSaveAvailable: diagnose.nativeSaveAvailable, nativeUploadAvailable: diagnose.nativeUploadAvailable };
    const canvas = (await call('tapnow_canvas_read', { includeData: false })).structuredContent!;
    assert.equal(typeof canvas.canvasId, 'string');
    assert.ok(Array.isArray(canvas.nodes)); assert.ok(Array.isArray(canvas.edges));
    results.canvas = { canvasId: canvas.canvasId, nodeCount: canvas.nodes.length, edgeCount: canvas.edges.length, saveState: canvas.saveState };
    const capability = (await call('tapnow_generation_capabilities')).structuredContent!;
    assert.ok(Array.isArray(capability.supportedNodeKinds));
    results.capabilities = { supportedNodeKinds: capability.supportedNodeKinds, modelCategories: Object.keys(capability.models as object) };
    const screenshot = await call('tapnow_canvas_screenshot', { canvasId: canvas.canvasId });
    const images = screenshot.content.filter(c => c.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, 'image/png');
    assert.ok(images[0].data.length > 100);
    results.screenshot = { imageCount: images.length, mimeType: images[0].mimeType, base64Length: images[0].data.length };
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...results }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${stderr}`);
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
}
