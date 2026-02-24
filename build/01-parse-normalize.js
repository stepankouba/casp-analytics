import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const CACHE_DIR = join(__dirname, 'cache');

// ── MiCA Article 16 service codes ──────────────────────────────────────────
const SERVICE_DEFINITIONS = {
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

const VALID_SERVICE_CODES = new Set(Object.keys(SERVICE_DEFINITIONS));

// ── ISO 3166-1 alpha-2 EEA country codes ───────────────────────────────────
const EEA_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'LV', 'LI', 'LT', 'LU',
  'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

// Map of known non-standard → standard country codes
const COUNTRY_FIXES = {
  'EL': 'GR', // Greece: ESMA uses EL, ISO uses GR
};

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId(lei) {
  return createHash('sha256').update(lei).digest('hex').slice(0, 8);
}

/**
 * Parse service codes from the messy CSV field.
 * Strategy: extract single letter codes (a-j) that appear before a period or tab,
 * or match full-text descriptions to known services.
 */
function parseServiceCodes(raw) {
  if (!raw || !raw.trim()) return [];

  const codes = new Set();

  // Split on common delimiters: | ; and also handle comma-separated full descriptions
  const segments = raw.split(/[|;]/).map(s => s.trim()).filter(Boolean);

  for (const segment of segments) {
    // Try to match letter code at start: "a.", "a.\t", "a. providing..."
    const letterMatch = segment.match(/^([a-j])\s*[.\t]/i);
    if (letterMatch) {
      const code = letterMatch[1].toLowerCase();
      if (VALID_SERVICE_CODES.has(code)) {
        codes.add(code);
        continue;
      }
    }

    // Some entries have comma-separated codes like "e. execution..., g. reception..."
    const commaLetters = segment.match(/(?:^|,\s*)([a-j])\s*[.\t]/gi);
    if (commaLetters && commaLetters.length > 0) {
      for (const m of commaLetters) {
        const letter = m.replace(/^,\s*/, '').charAt(0).toLowerCase();
        if (VALID_SERVICE_CODES.has(letter)) {
          codes.add(letter);
        }
      }
      if (codes.size > 0) continue;
    }

    // Fallback: match full-text descriptions (for entries without letter prefix)
    const lower = segment.toLowerCase();
    if (lower.includes('custody') || lower.includes('administration')) codes.add('a');
    else if (lower.includes('trading platform') || lower.includes('operation of a trading')) codes.add('b');
    else if (lower.includes('exchange') && lower.includes('for funds')) codes.add('c');
    else if (lower.includes('exchange') && lower.includes('for other')) codes.add('d');
    else if (lower.includes('execution of orders')) codes.add('e');
    else if (lower.includes('placing')) codes.add('f');
    else if (lower.includes('reception and transmission') || lower.includes('reception')) codes.add('g');
    else if (lower.includes('advice') || lower.includes('advisory')) codes.add('h');
    else if (lower.includes('portfolio management')) codes.add('i');
    else if (lower.includes('transfer service')) codes.add('j');
  }

  return [...codes].sort();
}

/**
 * Normalize and validate country codes.
 */
function parseCountryCodes(raw) {
  if (!raw || !raw.trim()) return [];

  const codes = new Set();
  // Split on | ; , and whitespace combinations
  const parts = raw.split(/[|;,]+/).map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    let code = part.toUpperCase().trim();
    // Fix known issues
    if (COUNTRY_FIXES[code]) {
      code = COUNTRY_FIXES[code];
    }
    // Validate: must be exactly 2 uppercase letters
    if (/^[A-Z]{2}$/.test(code) && (EEA_COUNTRIES.has(code) || code === 'CH')) {
      codes.add(code);
    }
  }

  return [...codes].sort();
}

/**
 * Parse date from DD/MM/YYYY to ISO 8601.
 */
function parseDate(raw) {
  if (!raw || !raw.trim()) return null;
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Normalize website URL — ensure https:// prefix.
 */
function normalizeWebsite(raw) {
  if (!raw || !raw.trim()) return null;
  let url = raw.trim();
  // Some entries have trailing spaces or quotes
  url = url.replace(/["']+$/, '').replace(/^["']+/, '').trim();
  // Some entries have multiple URLs separated by | — take first
  if (url.includes('|')) {
    url = url.split('|')[0].trim();
  }
  // Skip non-URL values (like "N26 – Die erste Onlinebank, die du lieben wirst")
  if (!url.includes('.') || url.length > 200) return null;
  // Strip protocol first to normalize
  if (url.startsWith('http://')) url = url.slice(7);
  if (url.startsWith('https://')) url = url.slice(8);
  if (url.startsWith('https.//')) url = url.slice(8); // typo in Coinbase entry
  // Remove trailing slashes and spaces
  url = url.replace(/[\s/]+$/, '');
  return url ? `https://${url}` : null;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  // Read CSV with BOM handling
  let csvContent = readFileSync(join(DATA_DIR, 'CASPS.csv'), 'utf-8');
  // Strip UTF-8 BOM
  if (csvContent.charCodeAt(0) === 0xfeff) {
    csvContent = csvContent.slice(1);
  }

  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  });

  console.log(`📄 Parsed ${records.length} records from CASPS.csv`);

  const warnings = [];
  const casps = [];
  const seenLeis = new Map();

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const rowNum = i + 2; // +2 for header + 0-index

    const lei = (row.ae_lei || '').trim();
    if (!lei) {
      warnings.push(`Row ${rowNum}: Missing LEI, skipping`);
      continue;
    }

    // ── Home country: prefer ae_homeMemberState, fallback to ae_lei_cou_code ──
    let homeCountry = (row.ae_homeMemberState || '').trim().toUpperCase();
    if (!homeCountry || homeCountry.length !== 2) {
      homeCountry = (row.ae_lei_cou_code || '').trim().toUpperCase();
    }
    if (COUNTRY_FIXES[homeCountry]) {
      homeCountry = COUNTRY_FIXES[homeCountry];
    }
    if (!homeCountry || homeCountry.length !== 2) {
      warnings.push(`Row ${rowNum} (${lei}): Could not determine home country`);
    }

    // ── Service codes ──
    const services = parseServiceCodes(row.ac_serviceCode || '');
    if (services.length === 0) {
      warnings.push(`Row ${rowNum} (${lei}): No valid service codes parsed from: "${(row.ac_serviceCode || '').slice(0, 80)}..."`);
    }

    // Check for invalid service code letters in raw data
    const rawServices = row.ac_serviceCode || '';
    const allLetters = rawServices.match(/(?:^|[|;,])\s*([a-z])\s*[.\t]/gi);
    if (allLetters) {
      for (const m of allLetters) {
        const letter = m.replace(/^[|;,]\s*/, '').charAt(0).toLowerCase();
        if (!VALID_SERVICE_CODES.has(letter)) {
          warnings.push(`Row ${rowNum}: Invalid service code letter "${letter}"`);
        }
      }
    }

    // ── Passporting countries ──
    const passportingCountries = parseCountryCodes(row.ac_serviceCode_cou || '');

    // ── Website ──
    const website = normalizeWebsite(row.ae_website);
    const websitePlatform = normalizeWebsite(row.ae_website_platform);

    // ── Dates ──
    const authDate = parseDate(row.ac_authorisationNotificationDate);
    const authEndDate = parseDate(row.ac_authorisationEndDate);
    const lastUpdate = parseDate(row.ac_lastupdate);

    // ── Names ──
    const legalName = (row.ae_lei_name || '').trim();
    const commercialName = (row.ae_commercial_name || '').trim() || null;

    // ── Deduplicate by LEI ──
    if (seenLeis.has(lei)) {
      const existing = seenLeis.get(lei);
      // Merge: take the entry with more services, or more recent update
      const existingCasp = casps[existing.index];
      const existingServiceCount = existingCasp.services.length;
      const newServiceCount = services.length;

      if (newServiceCount > existingServiceCount) {
        // Replace with new entry that has more services
        warnings.push(`Row ${rowNum}: Duplicate LEI ${lei} (${legalName}) — replacing row ${existing.rowNum} (more services: ${newServiceCount} vs ${existingServiceCount})`);
        casps[existing.index] = buildCasp();
      } else {
        // Merge services from duplicate
        const mergedServices = [...new Set([...existingCasp.services, ...services])].sort();
        const mergedPassport = [...new Set([...existingCasp.passporting_countries, ...passportingCountries])].sort();
        if (mergedServices.length > existingCasp.services.length || mergedPassport.length > existingCasp.passporting_countries.length) {
          existingCasp.services = mergedServices;
          existingCasp.passporting_countries = mergedPassport;
          warnings.push(`Row ${rowNum}: Duplicate LEI ${lei} (${legalName}) — merged services/passporting into row ${existing.rowNum}`);
        } else {
          warnings.push(`Row ${rowNum}: Duplicate LEI ${lei} (${legalName}) — skipping (no new data vs row ${existing.rowNum})`);
        }
      }
      continue;
    }

    function buildCasp() {
      return {
        id: generateId(lei),
        lei,
        legal_name: legalName,
        commercial_name: commercialName,
        home_country: homeCountry,
        competent_authority: (row.ae_competentAuthority || '').trim(),
        address: (row.ae_address || '').trim() || null,
        website,
        website_platform: websitePlatform,
        auth_date: authDate,
        auth_end_date: authEndDate,
        services,
        passporting_countries: passportingCountries,
        last_update: lastUpdate,
        comments: (row.ac_comments || '').trim() || null,
      };
    }

    const casp = buildCasp();
    seenLeis.set(lei, { index: casps.length, rowNum });
    casps.push(casp);
  }

  // ── Validation report ──
  console.log(`\n✅ Normalized ${casps.length} unique CASPs`);

  // Service code stats
  const serviceCounts = {};
  for (const c of casps) {
    for (const s of c.services) {
      serviceCounts[s] = (serviceCounts[s] || 0) + 1;
    }
  }
  console.log('\n📊 Service code frequency:');
  for (const code of Object.keys(SERVICE_DEFINITIONS).sort()) {
    console.log(`  ${code}: ${serviceCounts[code] || 0} CASPs — ${SERVICE_DEFINITIONS[code]}`);
  }

  // Country stats
  const countryCounts = {};
  for (const c of casps) {
    countryCounts[c.home_country] = (countryCounts[c.home_country] || 0) + 1;
  }
  console.log('\n🌍 CASPs by home country:');
  for (const [country, count] of Object.entries(countryCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${country}: ${count}`);
  }

  // CASPs with no services
  const noServices = casps.filter(c => c.services.length === 0);
  if (noServices.length > 0) {
    console.log(`\n⚠️  ${noServices.length} CASPs with no parsed services`);
  }

  // CASPs with no website
  const noWebsite = casps.filter(c => !c.website);
  if (noWebsite.length > 0) {
    console.log(`⚠️  ${noWebsite.length} CASPs with no valid website`);
  }

  // Warnings
  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} warnings:`);
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
  }

  // ── Write output ──
  writeFileSync(
    join(CACHE_DIR, 'normalized.json'),
    JSON.stringify(casps, null, 2),
    'utf-8'
  );
  console.log(`\n💾 Written to build/cache/normalized.json`);
}

main();
