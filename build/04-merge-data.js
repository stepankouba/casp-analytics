import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const CACHE_DIR = join(__dirname, 'cache');
const DIST_DIR = join(ROOT, 'docs', 'data');

// ── Service reference ──────────────────────────────────────────────────────
const SERVICES_REFERENCE = {
  a: { code: 'a', name: 'Custody & administration', full: 'providing custody and administration of crypto-assets on behalf of clients' },
  b: { code: 'b', name: 'Trading platform', full: 'operation of a trading platform for crypto-assets' },
  c: { code: 'c', name: 'Exchange (fiat)', full: 'exchange of crypto-assets for funds' },
  d: { code: 'd', name: 'Exchange (crypto-crypto)', full: 'exchange of crypto-assets for other crypto-assets' },
  e: { code: 'e', name: 'Order execution', full: 'execution of orders for crypto-assets on behalf of clients' },
  f: { code: 'f', name: 'Placing', full: 'placing of crypto-assets' },
  g: { code: 'g', name: 'Order reception & transmission', full: 'reception and transmission of orders for crypto-assets on behalf of clients' },
  h: { code: 'h', name: 'Advisory', full: 'providing advice on crypto-assets' },
  i: { code: 'i', name: 'Portfolio management', full: 'providing portfolio management on crypto-assets' },
  j: { code: 'j', name: 'Transfer services', full: 'providing transfer services for crypto-assets on behalf of clients' },
};

function main() {
  mkdirSync(DIST_DIR, { recursive: true });

  // ── Load all data sources ──
  const normalized = JSON.parse(readFileSync(join(CACHE_DIR, 'normalized.json'), 'utf-8'));
  const enriched = JSON.parse(readFileSync(join(CACHE_DIR, 'enriched.json'), 'utf-8'));
  const countryMeta = JSON.parse(readFileSync(join(DATA_DIR, 'country_meta.json'), 'utf-8'));
  const marketSizing = JSON.parse(readFileSync(join(DATA_DIR, 'market_sizing.json'), 'utf-8'));

  // Load scrape data for success rate
  let scrapeSuccessRate = 0;
  if (existsSync(join(CACHE_DIR, 'scraped_raw.json'))) {
    const scrapeData = JSON.parse(readFileSync(join(CACHE_DIR, 'scraped_raw.json'), 'utf-8'));
    const successCount = scrapeData.filter(s => s.scrape_status === 'success' || s.scrape_status === 'partial').length;
    scrapeSuccessRate = scrapeData.length > 0 ? Math.round(successCount / scrapeData.length * 100) / 100 : 0;
  }

  console.log(`📦 Merging data:`);
  console.log(`   Normalized CASPs: ${normalized.length}`);
  console.log(`   Enriched CASPs: ${enriched.length}`);

  // ── Build enrichment map ──
  const enrichmentMap = {};
  for (const e of enriched) {
    enrichmentMap[e.lei] = e;
  }

  // ── Merge CASP records ──
  const casps = normalized.map(casp => {
    const enrichment = enrichmentMap[casp.lei] || {};
    return {
      ...casp,
      entity_type: enrichment.entity_type || 'other',
      target_segments: enrichment.target_segments || ['retail'],
      primary_products: enrichment.primary_products || [],
      confidence: enrichment.confidence || 'low',
      brief_description: enrichment.brief_description || null,
      classification_date: enrichment.classification_date || null,
      llm_model: enrichment.llm_model || null,
    };
  });

  // ── Compute country statistics ──
  const countries = {};
  for (const [code, meta] of Object.entries(countryMeta)) {
    const registered = casps.filter(c => c.home_country === code).length;
    const passported = casps.filter(c => c.passporting_countries.includes(code)).length;

    countries[code] = {
      ...meta,
      registered_casps: registered,
      passported_casps: passported,
      total_casps: registered + passported,
    };
  }

  // ── Compute LLM classification rate ──
  const llmClassified = enriched.filter(e => e.llm_model && e.llm_model !== 'fallback_heuristic').length;
  const llmClassificationRate = enriched.length > 0 ? Math.round(llmClassified / enriched.length * 100) / 100 : 0;

  // ── Build final app.json ──
  const appData = {
    metadata: {
      generated_at: new Date().toISOString(),
      source: 'ESMA MiCA Interim Register',
      total_casps: casps.length,
      scrape_success_rate: scrapeSuccessRate,
      llm_classification_rate: llmClassificationRate,
    },
    casps,
    countries,
    market_sizing: marketSizing,
    services_reference: SERVICES_REFERENCE,
  };

  // ── Validation ──
  const warnings = [];

  // Check all CASPs have enrichment
  const missingEnrichment = casps.filter(c => !c.entity_type || c.entity_type === 'other');
  if (missingEnrichment.length > 5) {
    warnings.push(`${missingEnrichment.length} CASPs with entity_type "other" or missing`);
  }

  // Check for duplicate LEIs
  const leis = new Set();
  for (const c of casps) {
    if (leis.has(c.lei)) {
      warnings.push(`Duplicate LEI: ${c.lei}`);
    }
    leis.add(c.lei);
  }

  // Check all services are valid
  for (const c of casps) {
    for (const s of c.services) {
      if (!SERVICES_REFERENCE[s]) {
        warnings.push(`Invalid service code "${s}" in ${c.legal_name}`);
      }
    }
  }

  // ── Output stats ──
  console.log(`\n📊 Merged data statistics:`);
  console.log(`   Total CASPs: ${casps.length}`);
  console.log(`   Countries with registered CASPs: ${Object.values(countries).filter(c => c.registered_casps > 0).length}`);
  console.log(`   Countries with passported CASPs: ${Object.values(countries).filter(c => c.passported_casps > 0).length}`);
  console.log(`   Scrape success rate: ${(scrapeSuccessRate * 100).toFixed(0)}%`);
  console.log(`   LLM classification rate: ${(llmClassificationRate * 100).toFixed(0)}%`);

  // Entity type breakdown
  const entityTypes = {};
  for (const c of casps) {
    entityTypes[c.entity_type] = (entityTypes[c.entity_type] || 0) + 1;
  }
  console.log(`\n   Entity types:`);
  for (const [type, count] of Object.entries(entityTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${type}: ${count}`);
  }

  // Top passporting targets
  const passportTargets = {};
  for (const c of casps) {
    for (const p of c.passporting_countries) {
      passportTargets[p] = (passportTargets[p] || 0) + 1;
    }
  }
  const topTargets = Object.entries(passportTargets).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`\n   Top passporting targets:`);
  for (const [code, count] of topTargets) {
    const name = countryMeta[code]?.name || code;
    console.log(`     ${name} (${code}): ${count} CASPs`);
  }

  if (warnings.length > 0) {
    console.log(`\n   ⚠️  Warnings:`);
    for (const w of warnings) {
      console.log(`     - ${w}`);
    }
  }

  // ── Write output ──
  const jsonStr = JSON.stringify(appData, null, 2);
  writeFileSync(join(DIST_DIR, 'app.json'), jsonStr, 'utf-8');

  const sizeKB = Math.round(Buffer.byteLength(jsonStr) / 1024);
  console.log(`\n💾 Written to docs/data/app.json (${sizeKB} KB)`);
}

main();
