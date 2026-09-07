import { createHash } from 'crypto';
import Ajv, { type ValidateFunction } from 'ajv';

export const INSTAGRAM_PREVIEW_OPERATIONS = ['analyze-instagram-brand', 'prepare-event-brief', 'build-campaign-image-prompts'] as const;
export type InstagramPreviewOperation = typeof INSTAGRAM_PREVIEW_OPERATIONS[number];
export type WorkflowSkillReference = { path: string; mode: 'legacy' | 'shadow' | 'skill' };
type Operation = { id: InstagramPreviewOperation; inputSchema: string; outputSchema: string; template: string; variables: string[] };
export type PreviewPackage = {
  fingerprint: string;
  files: Record<string, string>;
  operations: Record<InstagramPreviewOperation, Operation & { input: ValidateFunction; output: ValidateFunction }>;
};
const forbidden = /^(?:html|jsx|css|javascript|script|scripts|code|eval|expression|credentials?|apiKey|providerId|modelId|endpoint|workflow|__proto__|prototype|constructor)$/i;

export function validateWorkflowSkillReference(value: unknown): WorkflowSkillReference {
  const ref = value as WorkflowSkillReference;
  if (!ref || Object.keys(ref).some(key => !['path', 'mode'].includes(key)) || !/^skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ref.path) || !['legacy', 'shadow', 'skill'].includes(ref.mode)) {
    throw new Error('Invalid workflowSkill reference');
  }
  return { path: ref.path, mode: ref.mode };
}

function checkSchema(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error('Schema nesting limit exceeded');
  if (!value || typeof value !== 'object') return;
  const schema = value as Record<string, unknown>;
  if ('$ref' in schema && (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/'))) throw new Error('Remote schema references are forbidden');
  if ('$id' in schema) throw new Error('External schema identities are forbidden');
  if (schema.type === 'object' && (schema.additionalProperties !== false || !schema.properties)) throw new Error('Object schemas must declare closed properties');
  if (schema.type === 'string' && (typeof schema.maxLength !== 'number' || schema.maxLength > 16000)) throw new Error('String schemas must be bounded');
  if (schema.type === 'array' && (typeof schema.maxItems !== 'number' || schema.maxItems > 50)) throw new Error('Array schemas must be bounded');
  if (schema.properties && Object.keys(schema.properties).some(key => forbidden.test(key))) throw new Error('Executable output fields are forbidden');
  for (const item of Object.values(schema)) checkSchema(item, depth + 1);
}

export function validatePreviewPackage(files: Record<string, string>): PreviewPackage {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > 16 || entries.reduce((n, [, content]) => n + Buffer.byteLength(content), 0) > 256 * 1024) throw new Error('Package size limit exceeded');
  for (const [name, content] of entries) {
    if (!/^(SKILL\.md|references\/[A-Za-z0-9_-]+\.md|assets\/[A-Za-z0-9_.-]+\.json)$/.test(name) || Buffer.byteLength(content) > 64 * 1024) throw new Error('Unsafe package file');
  }
  if (!files['SKILL.md']?.trim() || !files['references/PROMPT.md']?.trim()) throw new Error('Missing workflow skill instructions');
  const capability = JSON.parse(files['assets/capability.json'] || 'null');
  if (!capability || capability.schemaVersion !== 1 || Object.keys(capability).some(key => !['schemaVersion', 'operations'].includes(key)) || !Array.isArray(capability.operations) || capability.operations.length !== 3) throw new Error('Invalid preview capability');
  const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false, ownProperties: true });
  const operations = {} as PreviewPackage['operations'];
  const referenced = new Set(['SKILL.md', 'references/PROMPT.md', 'assets/capability.json']);
  for (const operation of capability.operations as Operation[]) {
    if (!INSTAGRAM_PREVIEW_OPERATIONS.includes(operation.id) || operations[operation.id] || Object.keys(operation).some(key => !['id', 'inputSchema', 'outputSchema', 'template', 'variables'].includes(key))) throw new Error('Undeclared or duplicate operation');
    if (!Array.isArray(operation.variables) || operation.variables.length > 12 || operation.variables.some(v => !/^[a-z][a-z_]{0,40}$/.test(v) || forbidden.test(v))) throw new Error('Invalid template variables');
    for (const name of [operation.inputSchema, operation.outputSchema, operation.template]) {
      if (!Object.prototype.hasOwnProperty.call(files, name)) throw new Error('Missing package dependency');
      referenced.add(name);
    }
    if (![operation.inputSchema, operation.outputSchema].every(p => /^assets\/[a-z0-9_.-]+\.json$/.test(p)) || !/^references\/[A-Za-z0-9_-]+\.md$/.test(operation.template)) throw new Error('Invalid dependency path');
    const inputSchema = JSON.parse(files[operation.inputSchema]);
    const outputSchema = JSON.parse(files[operation.outputSchema]);
    if (inputSchema?.type !== 'object' || outputSchema?.type !== 'object') throw new Error('Operation schemas must describe closed objects');
    checkSchema(inputSchema);
    checkSchema(outputSchema);
    operations[operation.id] = { ...operation, input: ajv.compile(inputSchema), output: ajv.compile(outputSchema) };
    renderPreviewTemplate(files[operation.template], Object.fromEntries(operation.variables.map(key => [key, 'fixture'])), operation.variables);
  }
  if (entries.some(([name]) => !referenced.has(name))) throw new Error('Unreferenced package file');
  const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { fingerprint, files: { ...files }, operations };
}

/** Literal single-pass substitution only; inserted user text is never interpreted. */
export function renderPreviewTemplate(template: string, values: Record<string, string>, allowed: string[]): string {
  if (template.length > 16000) throw new Error('Template size limit exceeded');
  const remaining = template.replace(/\{\{([a-z][a-z_]{0,40})\}\}/g, (_match, key: string) => {
    if (!allowed.includes(key) || !Object.prototype.hasOwnProperty.call(values, key)) throw new Error('Undeclared template variable');
    return '';
  });
  if (/[{}]/.test(remaining)) throw new Error('Template expressions are forbidden');
  return template.replace(/\{\{([a-z][a-z_]{0,40})\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (typeof value !== 'string' || value.length > 32000) throw new Error('Template input limit exceeded');
    return value;
  });
}

/** Opt-in only: callers retain the historical definition hash without a package. */
export function fingerprintWorkflowPreview(definitionFingerprint: string, packageFingerprint?: string): string {
  return packageFingerprint ? createHash('sha256').update(JSON.stringify({ definitionFingerprint, packageFingerprint })).digest('hex') : definitionFingerprint;
}
