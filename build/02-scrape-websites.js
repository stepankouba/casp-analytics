import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, 'cache');
const SCRAPE_CACHE = join(CACHE_DIR, 'scraped_raw.json');
const ERROR_LOG = join(CACHE_DIR, 'scrape_errors.log');

const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY || '5', 10);
const SKIP_SCRAPE = process.env.SKIP_SCRAPE === 'true';
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const MAX_TEXT_LENGTH = 3000;

// Pages to attempt beyond homepage
const SUBPAGES = ['/about', '/services', '/about-us'];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch a URL with timeout and retries.
 */
async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'MiCA-CASP-Analytics/1.0 (research; contact@example.com)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        throw new Error(`Non-HTML content-type: ${contentType}`);
      }

      return await response.text();
    } catch (err) {
      if (attempt === retries) throw err;
      // Exponential backoff
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

/**
 * Extract useful text from HTML.
 */
function extractContent(html) {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim() || null;
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;
  const metaKeywords = $('meta[name="keywords"]').attr('content')?.trim() || null;
  const lang = $('html').attr('lang')?.trim()?.slice(0, 5) || null;

  // Remove script, style, nav, footer, header elements for cleaner text
  $('script, style, noscript, nav, footer, header, iframe, svg, img').remove();

  // Extract visible text
  let pageText = $('body').text() || '';
  // Collapse whitespace
  pageText = pageText.replace(/\s+/g, ' ').trim();
  // Truncate
  if (pageText.length > MAX_TEXT_LENGTH) {
    pageText = pageText.slice(0, MAX_TEXT_LENGTH);
  }

  return { title, metaDescription, metaKeywords, lang, pageText };
}

/**
 * Check robots.txt (best effort).
 */
async function checkRobots(baseUrl) {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MiCA-CASP-Analytics/1.0' },
    });
    clearTimeout(timer);

    if (!resp.ok) return true; // No robots.txt = allowed

    const text = await resp.text();
    // Simple check: look for "Disallow: /" in User-agent: * section
    const lines = text.split('\n');
    let inAllSection = false;
    for (const line of lines) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith('user-agent:')) {
        inAllSection = trimmed.includes('*');
      }
      if (inAllSection && trimmed === 'disallow: /') {
        return false; // Fully blocked
      }
    }
    return true;
  } catch {
    return true; // Can't fetch robots.txt = assume allowed
  }
}

/**
 * Scrape a single CASP.
 */
async function scrapeCasp(casp) {
  const result = {
    lei: casp.lei,
    scrape_status: 'failed',
    scrape_date: new Date().toISOString().slice(0, 10),
    title: null,
    meta_description: null,
    page_text: null,
    detected_language: null,
    pages_scraped: [],
  };

  if (!casp.website) {
    result.scrape_status = 'failed';
    return { result, error: 'No website URL' };
  }

  let error = null;

  try {
    // Check robots.txt
    const allowed = await checkRobots(casp.website);
    if (!allowed) {
      result.scrape_status = 'failed';
      return { result, error: 'Blocked by robots.txt' };
    }

    // Scrape homepage
    const html = await fetchWithRetry(casp.website);
    const content = extractContent(html);
    result.title = content.title;
    result.meta_description = content.metaDescription;
    result.detected_language = content.lang;
    result.pages_scraped.push(casp.website);

    let allText = content.pageText || '';

    // Check if we got enough content
    if (allText.length < 500) {
      result.scrape_status = 'partial';
    } else {
      result.scrape_status = 'success';
    }

    // Try subpages for more content
    for (const subpage of SUBPAGES) {
      try {
        const subUrl = new URL(subpage, casp.website).href;
        const subHtml = await fetchWithRetry(subUrl, 1); // Only 1 try for subpages
        const subContent = extractContent(subHtml);
        if (subContent.pageText && subContent.pageText.length > 100) {
          allText += ' ' + subContent.pageText;
          result.pages_scraped.push(subUrl);
          if (result.scrape_status === 'partial') {
            result.scrape_status = 'success';
          }
        }
      } catch {
        // Subpage failures are fine
      }
    }

    // Truncate combined text
    result.page_text = allText.slice(0, MAX_TEXT_LENGTH);
  } catch (err) {
    error = err.message;
    result.scrape_status = 'failed';
  }

  return { result, error };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  if (SKIP_SCRAPE) {
    console.log('⏭️  SKIP_SCRAPE=true, skipping scraper');
    if (existsSync(SCRAPE_CACHE)) {
      console.log('   Using existing cache');
    } else {
      console.log('   ⚠️  No cache exists — subsequent steps will work without scrape data');
    }
    return;
  }

  // Load normalized data
  const casps = JSON.parse(readFileSync(join(CACHE_DIR, 'normalized.json'), 'utf-8'));
  console.log(`🌐 Starting scrape of ${casps.length} CASPs (concurrency: ${CONCURRENCY})`);

  // Load existing cache for incremental scraping
  let existingResults = {};
  if (existsSync(SCRAPE_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(SCRAPE_CACHE, 'utf-8'));
      for (const r of cached) {
        if (r.scrape_status === 'success') {
          existingResults[r.lei] = r;
        }
      }
      console.log(`   📦 Found ${Object.keys(existingResults).length} cached successful results`);
    } catch {
      console.log('   ⚠️  Could not parse existing cache, re-scraping all');
    }
  }

  // Clear error log
  writeFileSync(ERROR_LOG, `Scrape errors — ${new Date().toISOString()}\n${'='.repeat(60)}\n`, 'utf-8');

  const limit = pLimit(CONCURRENCY);
  const results = [];
  let completed = 0;
  let successCount = 0;
  let partialCount = 0;
  let failedCount = 0;
  let cachedCount = 0;

  const tasks = casps.map(casp =>
    limit(async () => {
      // Skip if we have a cached successful result
      if (existingResults[casp.lei]) {
        cachedCount++;
        completed++;
        return existingResults[casp.lei];
      }

      const { result, error } = await scrapeCasp(casp);
      completed++;

      const status = result.scrape_status;
      if (status === 'success') successCount++;
      else if (status === 'partial') partialCount++;
      else failedCount++;

      // Log progress every 10 entries
      if (completed % 10 === 0 || completed === casps.length) {
        console.log(`   [${completed}/${casps.length}] ✅${successCount} 🟡${partialCount} ❌${failedCount} 📦${cachedCount}`);
      }

      if (error) {
        const logLine = `[${status}] ${casp.legal_name} (${casp.website || 'no URL'}): ${error}\n`;
        appendFileSync(ERROR_LOG, logLine, 'utf-8');
      }

      return result;
    })
  );

  const allResults = await Promise.all(tasks);
  const totalSuccess = allResults.filter(r => r.scrape_status === 'success').length;
  const totalPartial = allResults.filter(r => r.scrape_status === 'partial').length;
  const totalFailed = allResults.filter(r => r.scrape_status === 'failed').length;

  console.log(`\n📊 Scrape results:`);
  console.log(`   ✅ Success:  ${totalSuccess} (${(totalSuccess / casps.length * 100).toFixed(1)}%)`);
  console.log(`   🟡 Partial:  ${totalPartial} (${(totalPartial / casps.length * 100).toFixed(1)}%)`);
  console.log(`   ❌ Failed:   ${totalFailed} (${(totalFailed / casps.length * 100).toFixed(1)}%)`);
  console.log(`   📦 From cache: ${cachedCount}`);

  writeFileSync(SCRAPE_CACHE, JSON.stringify(allResults, null, 2), 'utf-8');
  console.log(`\n💾 Written to build/cache/scraped_raw.json`);
  console.log(`📋 Errors logged to build/cache/scrape_errors.log`);
}

main().catch(err => {
  console.error('Fatal scraper error:', err);
  process.exit(1);
});
