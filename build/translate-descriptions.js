import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, 'cache');
const ENRICHED_PATH = join(CACHE_DIR, 'enriched.json');

async function main() {
  const client = new Anthropic();
  const enriched = JSON.parse(readFileSync(ENRICHED_PATH, 'utf-8'));

  // Collect all Czech descriptions
  const toTranslate = enriched
    .filter(e => e.brief_description && e.brief_description.length > 5)
    .map(e => ({ lei: e.lei, text: e.brief_description }));

  console.log(`🌐 Translating ${toTranslate.length} descriptions from Czech to English...`);

  // Batch into chunks of ~30 to fit in a single prompt
  const BATCH_SIZE = 30;
  const batches = [];
  for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
    batches.push(toTranslate.slice(i, i + BATCH_SIZE));
  }

  const limit = pLimit(2);
  const translations = {};

  const tasks = batches.map((batch, idx) =>
    limit(async () => {
      const items = batch.map((b, i) => `${i + 1}. [${b.lei}] ${b.text}`).join('\n');

      const msg = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `Translate each Czech description to English. Keep them concise (one sentence each). Return ONLY a JSON object mapping LEI to translated text.\n\n${items}`
        }],
      });

      const text = msg.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        Object.assign(translations, parsed);
      }
      console.log(`   Batch ${idx + 1}/${batches.length} done (${Object.keys(translations).length} translated)`);
    })
  );

  await Promise.all(tasks);

  // Apply translations
  let updated = 0;
  for (const e of enriched) {
    if (translations[e.lei]) {
      e.brief_description = translations[e.lei];
      updated++;
    }
  }

  writeFileSync(ENRICHED_PATH, JSON.stringify(enriched, null, 2), 'utf-8');
  console.log(`\n✅ Updated ${updated}/${toTranslate.length} descriptions`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
