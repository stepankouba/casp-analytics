/**
 * Step 4b: Compute register changes against the previously published version.
 *
 * The reference "previous version" is the last committed docs/data/app.json,
 * because a commit is what gets published to GitHub Pages. The diff is added
 * to docs/data/app.json as a `changes` object consumed by the "What's new" tab.
 *
 * If git or the previous file is unavailable, the step warns and leaves
 * app.json untouched — the build must never fail because of a missing baseline.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APP_JSON = join(ROOT, 'docs', 'data', 'app.json');
const GIT_PATH = 'docs/data/app.json';

// Registry fields worth reporting as a change. LLM enrichment fields
// (brief_description, target_segments, ...) are deliberately excluded —
// they change with re-classification, not with the register.
const TRACKED_FIELDS = ['services', 'passporting_countries', 'auth_end_date', 'home_country'];

// Fields carried over into added/removed entries for display.
const ENTRY_FIELDS = [
  'id', 'lei', 'legal_name', 'commercial_name', 'home_country',
  'competent_authority', 'auth_date', 'services', 'passporting_countries',
];

function keyOf(casp) {
  return casp.lei || casp.id;
}

function loadPrevious(ref = 'HEAD') {
  try {
    const raw = execFileSync('git', ['show', `${ref}:${GIT_PATH}`], {
      cwd: ROOT,
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.casps)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pickEntry(casp) {
  const entry = {};
  for (const f of ENTRY_FIELDS) {
    entry[f] = casp[f] ?? null;
  }
  return entry;
}

function normalizeValue(value) {
  if (Array.isArray(value)) return [...value].sort().join(',');
  return value ?? null;
}

function diffFields(prev, curr) {
  const fields = [];
  for (const field of TRACKED_FIELDS) {
    const from = normalizeValue(prev[field]);
    const to = normalizeValue(curr[field]);
    if (from !== to) {
      fields.push({ field, from: prev[field] ?? null, to: curr[field] ?? null });
    }
  }
  return fields;
}

function displayName(casp) {
  return casp.commercial_name || casp.legal_name || '';
}

function byCountryThenName(a, b) {
  const ca = a.home_country || '';
  const cb = b.home_country || '';
  if (ca !== cb) return ca.localeCompare(cb);
  return displayName(a).localeCompare(displayName(b));
}

function computeChanges(previous, current) {
  const prevMap = new Map(previous.casps.map(c => [keyOf(c), c]));
  const currMap = new Map(current.casps.map(c => [keyOf(c), c]));

  const added = [];
  const modified = [];
  for (const [key, casp] of currMap) {
    const prev = prevMap.get(key);
    if (!prev) {
      added.push(pickEntry(casp));
      continue;
    }
    const fields = diffFields(prev, casp);
    if (fields.length > 0) {
      modified.push({
        id: casp.id,
        lei: casp.lei,
        legal_name: casp.legal_name,
        commercial_name: casp.commercial_name ?? null,
        home_country: casp.home_country,
        fields,
      });
    }
  }

  const removed = [];
  for (const [key, casp] of prevMap) {
    if (!currMap.has(key)) removed.push(pickEntry(casp));
  }

  return {
    previous_generated_at: previous.metadata?.generated_at ?? null,
    previous_total: previous.metadata?.total_casps ?? previous.casps.length,
    current_total: current.metadata?.total_casps ?? current.casps.length,
    added: added.sort(byCountryThenName),
    removed: removed.sort(byCountryThenName),
    modified: modified.sort(byCountryThenName),
  };
}

function main() {
  if (!existsSync(APP_JSON)) {
    console.error('❌ docs/data/app.json not found. Run npm run build:merge first.');
    process.exit(1);
  }

  const current = JSON.parse(readFileSync(APP_JSON, 'utf-8'));

  const previous = loadPrevious(process.env.DIFF_BASE_REF || 'HEAD');
  if (!previous) {
    console.warn('⚠️  No previous app.json available from git — skipping change detection.');
    return;
  }

  const changes = computeChanges(previous, current);

  // Keep `changes` right after metadata for readability of the JSON file.
  const { metadata, ...rest } = current;
  delete rest.changes;
  const output = { metadata, changes, ...rest };

  writeFileSync(APP_JSON, JSON.stringify(output, null, 2), 'utf-8');

  console.log('🔍 Register changes vs. previously published version:');
  console.log(`   Baseline generated at: ${changes.previous_generated_at || 'unknown'}`);
  console.log(`   Total CASPs: ${changes.previous_total} → ${changes.current_total}`);
  console.log(`   Added: ${changes.added.length}, removed: ${changes.removed.length}, changed: ${changes.modified.length}`);
  for (const a of changes.added.slice(0, 10)) {
    console.log(`     + ${displayName(a)} (${a.home_country})`);
  }
  if (changes.added.length > 10) console.log(`     + ... ${changes.added.length - 10} more`);
  for (const r of changes.removed) {
    console.log(`     - ${displayName(r)} (${r.home_country})`);
  }
  for (const m of changes.modified) {
    console.log(`     ~ ${displayName(m)} (${m.home_country}): ${m.fields.map(f => f.field).join(', ')}`);
  }
}

main();
