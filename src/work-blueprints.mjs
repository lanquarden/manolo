import { createHash } from 'node:crypto';

export const BLUEPRINT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_BLUEPRINTS = 12;
const MAX_DESCRIPTION = 160;
const MAX_INSTRUCTIONS = 4000;
const unsafeText = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('MANOLO_WORK_BLUEPRINTS must define at most 12 named, non-secret text blueprints with description and instructions.');

export function loadWorkBlueprints(raw) {
  if (raw === undefined) return new Map();
  if (raw.length > 64 * 1024) throw invalid();
  let value;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!isObject(value) || Object.keys(value).length > MAX_BLUEPRINTS) throw invalid();
  return new Map(Object.entries(value).map(([id, blueprint]) => {
    if (!BLUEPRINT_ID.test(id) || !isObject(blueprint) || Object.keys(blueprint).length !== 2 ||
        !Object.hasOwn(blueprint, 'description') || !Object.hasOwn(blueprint, 'instructions')) throw invalid();
    const fields = {};
    for (const [field, max] of [['description', MAX_DESCRIPTION], ['instructions', MAX_INSTRUCTIONS]]) {
      const text = blueprint[field];
      if (typeof text !== 'string' || !text.isWellFormed() || text.length > max) throw invalid();
      const normalized = text.replace(/\r\n?/g, '\n').trim();
      if (!normalized || unsafeText.test(normalized)) throw invalid();
      fields[field] = normalized;
    }
    const revision = createHash('sha256').update(JSON.stringify([id, fields.description, fields.instructions])).digest('hex');
    return [id, { id, ...fields, revision }];
  }));
}
