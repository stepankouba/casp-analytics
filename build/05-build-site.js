import { cpSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_DIR = join(ROOT, 'src');
const DIST_DIR = join(ROOT, 'docs');

function main() {
  const buildVersion = Date.now();

  // Ensure dist exists
  mkdirSync(DIST_DIR, { recursive: true });

  // Verify app.json exists
  const appJson = join(DIST_DIR, 'data', 'app.json');
  if (!existsSync(appJson)) {
    console.error('❌ dist/data/app.json not found. Run npm run build:merge first.');
    process.exit(1);
  }

  // Copy src files to dist
  const files = ['index.html', 'app.js', 'charts.js', 'filters.js', 'styles.css'];
  for (const file of files) {
    const src = join(SRC_DIR, file);
    const dst = join(DIST_DIR, file);
    if (existsSync(src)) {
      if (file === 'index.html') {
        const html = readFileSync(src, 'utf-8').replaceAll('__BUILD_VERSION__', buildVersion);
        writeFileSync(dst, html, 'utf-8');
      } else {
        cpSync(src, dst);
      }
      console.log(`   📄 ${file}`);
    } else {
      console.warn(`   ⚠️  ${file} not found in src/`);
    }
  }

  // CNAME docs
  writeFileSync(join(DIST_DIR, 'CNAME'), 'micamap.eu', 'utf-8');

  console.log(`\n✅ Static site built to docs/`);
  console.log(`   Run "npm run dev" to start local server`);
}

main();
