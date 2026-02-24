import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, 'cache');
const ENRICHED_CACHE = join(CACHE_DIR, 'enriched.json');

const LLM_CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '5', 10);
const SKIP_LLM = process.env.SKIP_LLM === 'true';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_RETRIES = 2;

// ── MiCA service full names ────────────────────────────────────────────────
const SERVICE_FULL = {
  a: 'providing custody and administration of crypto-assets on behalf of clients',
  b: 'operation of a trading platform for crypto-assets',
  c: 'exchange of crypto-assets for funds',
  d: 'exchange of crypto-assets for other crypto-assets',
  e: 'execution of orders for crypto-assets on behalf of clients',
  f: 'placing of crypto-assets',
  g: 'reception and transmission of orders for crypto-assets on behalf of clients',
  h: 'providing advice on crypto-assets',
  i: 'providing portfolio management on crypto-assets',
  j: 'providing transfer services for crypto-assets on behalf of clients',
};

// ── Heuristic pre-classification hints ─────────────────────────────────────
function getEntityHint(legalName, commercialName) {
  const combined = `${legalName} ${commercialName || ''}`.toLowerCase();

  if (/\b(bank|banque|banca|sparkasse|volksbank|raiffeisen|girozentrale)\b/.test(combined)) {
    return 'bank';
  }
  if (/\b(bit|coin|crypto|chain|block|swap|bybit|kraken|okx|binance|gate\.io|gemini)\b/.test(combined)) {
    return 'crypto_native';
  }
  if (/\b(pay|payment|skrill|neteller|revolut)\b/.test(combined)) {
    return 'payment_institution';
  }
  if (/\b(asset\s*manage|invest|capital|securities|portfolio|wealth|brokerage)\b/.test(combined)) {
    return 'investment_firm';
  }
  return null;
}

// ── Build prompt for one CASP ──────────────────────────────────────────────
function buildPrompt(casp, scrapeData) {
  const servicesText = casp.services
    .map(code => `${code}. ${SERVICE_FULL[code]}`)
    .join('\n   ');

  const passportText = casp.passporting_countries.length > 0
    ? casp.passporting_countries.join(', ')
    : '(none)';

  const hint = getEntityHint(casp.legal_name, casp.commercial_name);
  const hintLine = hint ? `\nHINT (heuristic guess from name): ${hint}` : '';

  let scrapeSection = 'Web scraping failed — classify based on registration data only.';
  if (scrapeData && scrapeData.page_text && scrapeData.page_text.length > 50) {
    const truncatedText = scrapeData.page_text.slice(0, 2000);
    scrapeSection = `Title: ${scrapeData.title || '(n/a)'}
Meta description: ${scrapeData.meta_description || '(n/a)'}
Page language: ${scrapeData.detected_language || '(n/a)'}
Page text (truncated):
${truncatedText}`;
  }

  return `Analyze the following CASP (Crypto-Asset Service Provider) registered under MiCA.

REGISTRATION DATA:
- Name: ${casp.legal_name} (${casp.commercial_name || 'n/a'})
- Country: ${casp.home_country}
- MiCA Services:
   ${servicesText}
- Passporting to: ${passportText}
- Web: ${casp.website || '(n/a)'}
${hintLine}

WEB SCRAPING DATA:
${scrapeSection}

Based on this information, classify:

1. ENTITY_TYPE: One of:
   - "bank" — traditional bank with a banking license
   - "investment_firm" — investment firm / asset manager
   - "crypto_native" — company founded as a crypto/blockchain startup
   - "payment_institution" — payment institution
   - "hybrid" — combination (e.g. neobank with crypto)
   - "other" — cannot determine

2. TARGET_SEGMENTS (array, 1-3 values):
   - "retail" — retail consumers
   - "professional" — professional investors
   - "institutional" — institutions (banks, funds, corporates)

3. PRIMARY_PRODUCTS (array, 1-5 values from):
   - "spot_exchange" — buying/selling cryptocurrencies
   - "custody" — crypto-asset custody
   - "staking" — staking services
   - "defi_access" — access to DeFi protocols
   - "otc_trading" — OTC trading
   - "derivatives" — derivatives / futures
   - "tokenization" — asset tokenization
   - "payment_services" — crypto payment services
   - "portfolio_management" — portfolio management
   - "advisory" — advisory services
   - "infrastructure" — B2B infrastructure (API, white-label)
   - "savings_investment" — crypto savings/investment products
   - "nft" — NFT marketplace
   - "crypto_atm" — crypto ATMs

4. CONFIDENCE: "high" | "medium" | "low"

5. BRIEF_DESCRIPTION: One-sentence description of the company and its focus (in English).

Respond ONLY with a valid JSON object with keys: entity_type, target_segments, primary_products, confidence, brief_description.`;
}

// ── Parse and validate LLM response ────────────────────────────────────────
const VALID_ENTITY_TYPES = new Set(['bank', 'investment_firm', 'crypto_native', 'payment_institution', 'hybrid', 'other']);
const VALID_SEGMENTS = new Set(['retail', 'professional', 'institutional']);
const VALID_PRODUCTS = new Set([
  'spot_exchange', 'custody', 'staking', 'defi_access', 'otc_trading',
  'derivatives', 'tokenization', 'payment_services', 'portfolio_management',
  'advisory', 'infrastructure', 'savings_investment', 'nft', 'crypto_atm',
]);

function parseResponse(text) {
  // Extract JSON from response (might be wrapped in markdown code block)
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }
  // Also try to find JSON object directly
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) {
    jsonStr = objMatch[0];
  }

  const parsed = JSON.parse(jsonStr);

  // Validate and sanitize
  if (!VALID_ENTITY_TYPES.has(parsed.entity_type)) {
    parsed.entity_type = 'other';
  }

  parsed.target_segments = (parsed.target_segments || [])
    .filter(s => VALID_SEGMENTS.has(s))
    .slice(0, 3);
  if (parsed.target_segments.length === 0) {
    parsed.target_segments = ['retail'];
  }

  parsed.primary_products = (parsed.primary_products || [])
    .filter(p => VALID_PRODUCTS.has(p))
    .slice(0, 5);
  if (parsed.primary_products.length === 0) {
    parsed.primary_products = ['spot_exchange'];
  }

  if (!['high', 'medium', 'low'].includes(parsed.confidence)) {
    parsed.confidence = 'low';
  }

  parsed.brief_description = (parsed.brief_description || '').slice(0, 300);

  return parsed;
}

// ── Classify a single CASP ─────────────────────────────────────────────────
async function classifyCasp(client, casp, scrapeData) {
  const prompt = buildPrompt(casp, scrapeData);

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });

      const responseText = message.content[0].text;
      const parsed = parseResponse(responseText);

      return {
        lei: casp.lei,
        entity_type: parsed.entity_type,
        target_segments: parsed.target_segments,
        primary_products: parsed.primary_products,
        confidence: parsed.confidence,
        brief_description: parsed.brief_description,
        classification_date: new Date().toISOString().slice(0, 10),
        llm_model: MODEL,
      };
    } catch (err) {
      if (attempt > MAX_RETRIES) {
        throw err;
      }
      console.warn(`   ⚠️  Retry ${attempt} for ${casp.commercial_name || casp.legal_name}: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// ── Fallback classification (no LLM) ──────────────────────────────────────
function fallbackClassify(casp) {
  const hint = getEntityHint(casp.legal_name, casp.commercial_name) || 'other';

  const products = [];
  if (casp.services.includes('a')) products.push('custody');
  if (casp.services.includes('c') || casp.services.includes('d')) products.push('spot_exchange');
  if (casp.services.includes('h')) products.push('advisory');
  if (casp.services.includes('i')) products.push('portfolio_management');
  if (casp.services.includes('j')) products.push('payment_services');
  if (products.length === 0) products.push('spot_exchange');

  return {
    lei: casp.lei,
    entity_type: hint,
    target_segments: ['retail'],
    primary_products: products.slice(0, 5),
    confidence: 'low',
    brief_description: `${casp.commercial_name || casp.legal_name} — automatická klasifikace bez LLM.`,
    classification_date: new Date().toISOString().slice(0, 10),
    llm_model: 'fallback_heuristic',
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  if (SKIP_LLM) {
    console.log('⏭️  SKIP_LLM=true, skipping classification');
    if (existsSync(ENRICHED_CACHE)) {
      console.log('   Using existing cache');
    } else {
      console.log('   ⚠️  No cache exists — generating fallback classifications');
      const casps = JSON.parse(readFileSync(join(CACHE_DIR, 'normalized.json'), 'utf-8'));
      const results = casps.map(c => fallbackClassify(c));
      writeFileSync(ENRICHED_CACHE, JSON.stringify(results, null, 2), 'utf-8');
      console.log(`   💾 Written ${results.length} fallback classifications`);
    }
    return;
  }

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set. Either:');
    console.error('   export ANTHROPIC_API_KEY=sk-ant-...');
    console.error('   or run with SKIP_LLM=true to use heuristic fallback');
    process.exit(1);
  }

  const client = new Anthropic();

  // Load data
  const casps = JSON.parse(readFileSync(join(CACHE_DIR, 'normalized.json'), 'utf-8'));
  const scrapeMap = {};
  if (existsSync(join(CACHE_DIR, 'scraped_raw.json'))) {
    const scrapeData = JSON.parse(readFileSync(join(CACHE_DIR, 'scraped_raw.json'), 'utf-8'));
    for (const s of scrapeData) {
      scrapeMap[s.lei] = s;
    }
  }

  console.log(`🤖 Starting LLM classification of ${casps.length} CASPs`);
  console.log(`   Model: ${MODEL} | Concurrency: ${LLM_CONCURRENCY}`);

  // Load existing cache for incremental classification
  const existingMap = {};
  if (existsSync(ENRICHED_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(ENRICHED_CACHE, 'utf-8'));
      for (const r of cached) {
        if (r.llm_model === MODEL) {
          existingMap[r.lei] = r;
        }
      }
      console.log(`   📦 Found ${Object.keys(existingMap).length} cached results for ${MODEL}`);
    } catch {
      console.log('   ⚠️  Could not parse existing cache, re-classifying all');
    }
  }

  const limit = pLimit(LLM_CONCURRENCY);
  let completed = 0;
  let apiCalls = 0;
  let cachedCount = 0;
  let failedCount = 0;

  const tasks = casps.map(casp =>
    limit(async () => {
      // Use cache if available
      if (existingMap[casp.lei]) {
        cachedCount++;
        completed++;
        return existingMap[casp.lei];
      }

      const scrapeData = scrapeMap[casp.lei] || null;

      try {
        const result = await classifyCasp(client, casp, scrapeData);
        apiCalls++;
        completed++;

        if (completed % 10 === 0 || completed === casps.length) {
          console.log(`   [${completed}/${casps.length}] API: ${apiCalls} | Cached: ${cachedCount} | Failed: ${failedCount}`);
        }

        return result;
      } catch (err) {
        failedCount++;
        completed++;
        console.error(`   ❌ ${casp.commercial_name || casp.legal_name}: ${err.message}`);
        // Return fallback
        return fallbackClassify(casp);
      }
    })
  );

  const results = await Promise.all(tasks);

  // Stats
  const byType = {};
  const byConfidence = {};
  for (const r of results) {
    byType[r.entity_type] = (byType[r.entity_type] || 0) + 1;
    byConfidence[r.confidence] = (byConfidence[r.confidence] || 0) + 1;
  }

  console.log(`\n📊 Classification results:`);
  console.log(`   API calls: ${apiCalls} | From cache: ${cachedCount} | Fallback: ${failedCount}`);
  console.log(`\n   Entity types:`);
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${type}: ${count}`);
  }
  console.log(`\n   Confidence:`);
  for (const [conf, count] of Object.entries(byConfidence).sort()) {
    console.log(`     ${conf}: ${count}`);
  }

  writeFileSync(ENRICHED_CACHE, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\n💾 Written to build/cache/enriched.json`);
}

main().catch(err => {
  console.error('Fatal classification error:', err);
  process.exit(1);
});
