# MiCA CASP Analytics — Specifikace pro Claude Code

## 1. Přehled projektu

### Cíl
Vytvořit statickou HTML/JS analytickou aplikaci nad interim MiCA registrem CASPs (Crypto-Asset Service Providers). Aplikace umožní interaktivní analýzu konkurenčního prostředí v EU krypto-regulaci — identifikaci hráčů, jejich služeb, passportingových strategií a tržního potenciálu.

### Klíčová omezení
- **Žádný backend** — vše se generuje při buildu, výstupem je čistě statická HTML/JS/CSS aplikace
- **Build pipeline v Node.js** — skripty pro scraping, LLM enrichment a generování dat běží lokálně
- **Data jsou embedded** — výsledný JSON se vloží přímo do bundle nebo jako statický soubor
- **Nasaditelné na GitHub Pages / Netlify / Vercel static**

### Zdrojová data
- **Primární:** `CASPS.csv` — interim MiCA registr z ESMA (150 záznamů, 15 sloupců)
- **Sekundární (build-time):** web scraping + LLM klasifikace jednotlivých CASPs
- **Statická (manuální):** market sizing data z veřejných reportů (ECB, EBA, ESMA, Chainalysis)

---

## 2. Architektura

```
┌─────────────────────────────────────────────────────────────────┐
│                        BUILD PIPELINE                           │
│                                                                 │
│  CASPS.csv ──► [1. Parser & Normalizer] ──► normalized.json     │
│                                                                 │
│  normalized.json ──► [2. Web Scraper] ──► scraped_raw.json      │
│                                                                 │
│  scraped_raw.json ──► [3. LLM Classifier] ──► enriched.json    │
│                                                                 │
│  market_data.json (manuální) ──┐                                │
│  enriched.json ────────────────┴► [4. Data Merger] ──► app.json │
│                                                                 │
│  app.json ──► [5. Static Site Build] ──► dist/                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     RUNTIME (browser)                           │
│                                                                 │
│  dist/index.html + app.js + app.json                            │
│  → Filtry, vizualizace, interaktivní tabulky                    │
└─────────────────────────────────────────────────────────────────┘
```

### Adresářová struktura

```
mica-casp-analytics/
├── data/
│   ├── CASPS.csv                    # Zdrojový ESMA registr
│   ├── market_sizing.json           # Manuálně připravená tržní data
│   └── country_meta.json            # ISO kódy, názvy zemí, populace, HDP
├── build/
│   ├── 01-parse-normalize.js        # CSV → normalized.json
│   ├── 02-scrape-websites.js        # Web scraping všech CASPs
│   ├── 03-llm-classify.js           # LLM enrichment (Anthropic API)
│   ├── 04-merge-data.js             # Spojení všech zdrojů → app.json
│   ├── 05-build-site.js             # Generování statického webu
│   └── cache/                       # Cache scraped/LLM výsledků
│       ├── scraped_raw.json
│       └── enriched.json
├── src/
│   ├── index.html
│   ├── app.js                       # Hlavní logika UI
│   ├── charts.js                    # Vizualizační modul
│   ├── filters.js                   # Filtrování a vyhledávání
│   └── styles.css
├── dist/                            # Výstupní build
├── package.json
└── README.md
```

---

## 3. Build Pipeline — Detail jednotlivých kroků

### Krok 1: Parser & Normalizer (`01-parse-normalize.js`)

Vstup: `CASPS.csv`
Výstup: `build/cache/normalized.json`

**Úkoly:**
1. Načíst CSV s UTF-8 BOM handling
2. **Normalizace service codes** — data obsahují nekonzistence:
   - Taby vs. mezery (`a.\tproviding` vs. `a. providing`)
   - Chybějící/zkrácený text (`d. exchange of crypto-assets for other` bez "crypto-assets")
   - Nekonzistentní tečky na konci
   - Oddělovače `|`, `;`, `,` a dokonce čárky uvnitř textu
   - → Normalizovat na jednopísmenné kódy `a` až `j` dle Article 16 MiCA
3. **Normalizace country codes:**
   - Opravit `GR` ↔ `EL` (Řecko), `Fi` → `FI` (case)
   - Validovat proti ISO 3166-1 alpha-2
   - Rozdělit na pole
4. **Parsování dat** — formát `DD/MM/YYYY` → ISO 8601
5. **Deduplikace** — kontrola na duplicitní LEI nebo názvy

**Výstupní schema (per CASP):**
```json
{
  "id": "sha256(lei)[:8]",
  "lei": "5299005V5GBSN2A4C303",
  "legal_name": "Bybit EU GmbH",
  "commercial_name": "Bybit",
  "home_country": "AT",
  "competent_authority": "Austrian Financial Market Authority (FMA)",
  "address": "Donau-City-Straße 7, 1220 Vienna, Austria",
  "website": "https://www.bybit.eu",
  "website_platform": null,
  "auth_date": "2025-05-28",
  "auth_end_date": null,
  "services": ["a", "c", "d", "f", "j"],
  "passporting_countries": ["BE", "BG", "CY", "CZ", "DE", ...],
  "last_update": "2025-05-28",
  "comments": null
}
```

### Krok 2: Web Scraper (`02-scrape-websites.js`)

Vstup: `build/cache/normalized.json`
Výstup: `build/cache/scraped_raw.json`

**Přístup:**
- Fetch HTML homepage + případně `/about`, `/services`, `/pricing`
- Timeout 10s per request, max 3 retries
- Respektovat robots.txt (best effort)
- **Cache výsledky** — při re-runu přeskočit již stažené (idempotentní build)
- Pro JS-heavy stránky: zkusit plain HTTP fetch, pokud výsledek < 500 znaků textu, zalogovat jako "needs_manual_review"

**Extrahovat:**
- `<title>`, `<meta name="description">`, `<meta name="keywords">`
- Viditelný text (strip HTML, omezit na prvních 3000 znaků)
- Detekce jazyka stránky (`<html lang="...">`)

**Výstupní schema (per CASP):**
```json
{
  "lei": "5299005V5GBSN2A4C303",
  "scrape_status": "success|partial|failed",
  "scrape_date": "2025-02-16",
  "title": "Bybit EU - Crypto Exchange",
  "meta_description": "Trade Bitcoin, Ethereum...",
  "page_text": "Bybit is a leading crypto exchange...",
  "detected_language": "en",
  "pages_scraped": ["https://www.bybit.eu", "https://www.bybit.eu/about"]
}
```

**Error handling:**
- Logovat všechny failures do `build/cache/scrape_errors.log`
- Generovat report: kolik success / partial / failed
- Neblokovat build při failures — LLM krok pracuje s tím co je dostupné

### Krok 3: LLM Classifier (`03-llm-classify.js`)

Vstup: `build/cache/normalized.json` + `build/cache/scraped_raw.json`
Výstup: `build/cache/enriched.json`

**Anthropic API call per CASP:**
- Model: `claude-sonnet-4-20250514` (optimální poměr cena/kvalita pro klasifikaci)
- **Cache výsledky** — volat API jen pro nové/změněné záznamy
- Rate limiting: max 5 concurrent requests, respektovat API rate limits

**Prompt template:**
```
Analyzuj následující CASP (Crypto-Asset Service Provider) registrovaný pod MiCA.

REGISTRAČNÍ DATA:
- Název: {legal_name} ({commercial_name})
- Země: {home_country}
- Služby MiCA: {services_full_text}
- Passporting do: {passporting_countries}
- Web: {website}

WEB SCRAPING DATA:
{scraped_text_truncated_to_2000_chars}

Na základě těchto informací klasifikuj:

1. ENTITY_TYPE: Jedna z hodnot:
   - "bank" — tradiční banka s bankovní licencí
   - "investment_firm" — investiční firma / asset manager
   - "crypto_native" — firma vzniklá jako krypto/blockchain startup
   - "payment_institution" — platební instituce
   - "hybrid" — kombinace (např. neobank s krypto)
   - "other" — nelze určit

2. TARGET_SEGMENTS (pole, 1-3 hodnoty):
   - "retail" — běžní spotřebitelé
   - "professional" — profesionální investoři
   - "institutional" — instituce (banky, fondy, corporate)

3. PRIMARY_PRODUCTS (pole, 1-5 hodnot z):
   - "spot_exchange" — nákup/prodej kryptoměn
   - "custody" — úschova krypto-aktiv
   - "staking" — staking služby
   - "defi_access" — přístup k DeFi protokolům
   - "otc_trading" — OTC obchodování
   - "derivatives" — deriváty / futures
   - "tokenization" — tokenizace aktiv
   - "payment_services" — platební služby s kryptem
   - "portfolio_management" — správa portfolia
   - "advisory" — poradenství
   - "infrastructure" — B2B infrastruktura (API, white-label)
   - "savings_investment" — spořicí/investiční produkty s kryptem
   - "nft" — NFT marketplace
   - "crypto_atm" — krypto bankomaty

4. CONFIDENCE: "high" | "medium" | "low"

5. BRIEF_DESCRIPTION: Jednovětný popis firmy a jejího zaměření (česky).

Odpověz POUZE jako validní JSON objekt.
```

**Výstupní schema (enrichment per CASP):**
```json
{
  "lei": "5299005V5GBSN2A4C303",
  "entity_type": "crypto_native",
  "target_segments": ["retail", "professional"],
  "primary_products": ["spot_exchange", "derivatives", "custody"],
  "confidence": "high",
  "brief_description": "Globální kryptoměnová burza zaměřená na retailové a profesionální obchodníky s deriváty a spot obchodováním.",
  "classification_date": "2025-02-16",
  "llm_model": "claude-sonnet-4-20250514"
}
```

**Fallback klasifikace (bez scraping dat):**
- Pokud scraping selhal, LLM klasifikuje pouze z názvu, služeb a země
- Tyto záznamy dostanou `confidence: "low"`
- Heuristická pre-klasifikace jako hint pro LLM:
  - Název obsahuje "Bank", "Banque", "Banca", "Sparkasse", "Volksbank" → hint `bank`
  - Název obsahuje "Bit", "Coin", "Crypto", "Chain", "Block", "Swap" → hint `crypto_native`

### Krok 4: Data Merger (`04-merge-data.js`)

Vstup: `enriched.json` + `data/market_sizing.json` + `data/country_meta.json`
Výstup: `dist/data/app.json`

Spojí všechna data do jednoho JSON souboru optimalizovaného pro frontend:

```json
{
  "metadata": {
    "generated_at": "2025-02-16T12:00:00Z",
    "source": "ESMA MiCA Interim Register",
    "total_casps": 150,
    "scrape_success_rate": 0.87,
    "llm_classification_rate": 0.95
  },
  "casps": [ /* pole enriched CASP objektů */ ],
  "countries": {
    "AT": {
      "name": "Austria",
      "name_local": "Österreich",
      "population": 9100000,
      "gdp_eur": 447000000000,
      "eea": true,
      "registered_casps": 7,
      "passported_casps": 75
    }
    /* ... */
  },
  "market_sizing": { /* viz sekce 5 */ },
  "services_reference": {
    "a": { "code": "a", "name": "Custody & administration", "full": "providing custody and administration of crypto-assets on behalf of clients" },
    "b": { "code": "b", "name": "Trading platform", "full": "operation of a trading platform for crypto-assets" },
    "c": { "code": "c", "name": "Exchange (fiat)", "full": "exchange of crypto-assets for funds" },
    "d": { "code": "d", "name": "Exchange (crypto-crypto)", "full": "exchange of crypto-assets for other crypto-assets" },
    "e": { "code": "e", "name": "Order execution", "full": "execution of orders for crypto-assets on behalf of clients" },
    "f": { "code": "f", "name": "Placing", "full": "placing of crypto-assets" },
    "g": { "code": "g", "name": "Order reception & transmission", "full": "reception and transmission of orders for crypto-assets on behalf of clients" },
    "h": { "code": "h", "name": "Advisory", "full": "providing advice on crypto-assets" },
    "i": { "code": "i", "name": "Portfolio management", "full": "providing portfolio management on crypto-assets" },
    "j": { "code": "j", "name": "Transfer services", "full": "providing transfer services for crypto-assets on behalf of clients" }
  }
}
```

### Krok 5: Static Site Build (`05-build-site.js`)

- Zkopírovat `src/` → `dist/`
- Inline nebo reference `app.json`
- Minifikace (volitelné)
- Generovat `dist/index.html` s embedded daty nebo fetch z `data/app.json`

---

## 4. Datový model — Market Sizing

### Soubor `data/market_sizing.json`

Manuálně připravený soubor s daty z veřejných zdrojů. Struktura:

```json
{
  "sources": [
    {
      "id": "chainalysis_2024",
      "name": "Chainalysis Geography of Cryptocurrency Report 2024",
      "url": "https://...",
      "date": "2024-10"
    },
    {
      "id": "ecb_2024",
      "name": "ECB Crypto-Asset Monitoring Report",
      "url": "https://...",
      "date": "2024-06"
    }
  ],
  "eu_totals": {
    "crypto_users_estimated": 50000000,
    "crypto_market_cap_eur": 2000000000000,
    "annual_trading_volume_eur": 5000000000000,
    "custody_aum_eur": 150000000000,
    "source": "ecb_2024"
  },
  "per_country": {
    "DE": {
      "crypto_adoption_pct": 8.1,
      "estimated_users": 6700000,
      "estimated_annual_volume_eur": 800000000000,
      "source": "chainalysis_2024"
    },
    "CZ": {
      "crypto_adoption_pct": 5.2,
      "estimated_users": 550000,
      "estimated_annual_volume_eur": 25000000000,
      "source": "chainalysis_2024"
    }
    /* ... pro všechny EEA země */
  },
  "per_service_eu": {
    "a": {
      "estimated_market_size_eur": 50000000000,
      "growth_rate_yoy": 0.35,
      "description": "Custody AuM across EU regulated entities",
      "source": "ecb_2024"
    },
    "c": {
      "estimated_market_size_eur": 3000000000000,
      "growth_rate_yoy": 0.20,
      "description": "Fiat-to-crypto exchange annual volume",
      "source": "chainalysis_2024"
    }
    /* ... pro služby a-j */
  }
}
```

**Poznámka k přípravě dat:**
Čísla jsou odhady založené na veřejně dostupných reportech. Při buildu se market_sizing.json validuje na schema a aplikace zobrazuje zdroje a disclaimery. Data jsou záměrně v separátním souboru, aby je bylo snadné aktualizovat bez zásahu do kódu.

**Zdroje k prohledání při přípravě:**
- Chainalysis Geography of Cryptocurrency Report (roční, regionální adopce)
- ECB Occasional Papers on crypto-assets
- EBA Report on crypto-asset activities
- ESMA TRV (Trends, Risks, Vulnerabilities) reports
- Statista / Eurostat pro populaci a HDP
- CoinGecko annual reports pro objemy

---

## 5. Frontend UI — Wireframe popis

### Technologie
- Vanilla JS (žádný framework) NEBO lightweight framework (Preact/Alpine.js — rozhodnutí na implementátorovi)
- Chart.js nebo Recharts pro vizualizace
- CSS Grid/Flexbox pro layout
- Responsivní design (desktop-first, ale funkční na tabletu)

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  HEADER: MiCA CASP Analytics Dashboard                       │
│  Metadata: 150 CASPs | Data as of: 2025-XX-XX | Sources     │
├──────────────────────────────────────────────────────────────┤
│  NAVIGATION TABS:                                            │
│  [Overview] [Country View] [CASP Explorer] [Market Sizing]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  TAB CONTENT (viz níže)                                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Tab 1: Overview

Souhrnný pohled na celý registr.

```
┌─────────────────────────────┬──────────────────────────────┐
│  KPI KARTY (4x)             │                              │
│  ┌────┐ ┌────┐ ┌────┐ ┌──┐ │                              │
│  │150 │ │ 18 │ │3.4 │ │27│ │  MAPA EU                     │
│  │CASP│ │zemí│ │avg │ │BK│ │  Heatmapa dle počtu CASPs    │
│  │    │ │    │ │svc │ │  │ │  (registrovaných +            │
│  └────┘ └────┘ └────┘ └──┘ │   passportovaných)           │
│  Total   Home   Avg    Bank│                              │
│  CASPs   cntry  svcs   cnt │                              │
├─────────────────────────────┤                              │
│  CHART: CASPs by home       │                              │
│  country (bar chart)        │                              │
├─────────────────────────────┼──────────────────────────────┤
│  CHART: Service frequency   │  CHART: Entity type          │
│  (horizontal bar, a-j)      │  breakdown (donut)           │
│                             │  bank / crypto / hybrid /... │
├─────────────────────────────┼──────────────────────────────┤
│  CHART: Auth timeline       │  CHART: Passporting heatmap  │
│  (line, by month)           │  (matrix: home → target)     │
└─────────────────────────────┴──────────────────────────────┘
```

### Tab 2: Country View

Výběr země a zobrazení competitive landscape.

```
┌──────────────────────────────────────────────────────────────┐
│  [ Dropdown: Vyberte zemi ▼ ]    [Toggle: Registrované |     │
│                                   Passportované | Obě ]      │
├──────────────────────────────────────────────────────────────┤
│  COUNTRY SUMMARY CARD                                        │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ 🇨🇿 Czech Republic                                       ││
│  │ Registrovaní: 0  |  Passportovaní: 74  |  Celkem: 74    ││
│  │ Odhadovaný trh: €25 mld ročně  |  Adopce: 5.2%          ││
│  │ Uživatelů: ~550 000  |  HDP: €290 mld                   ││
│  └──────────────────────────────────────────────────────────┘│
├──────────────────────────────┬───────────────────────────────┤
│  CHART: Services available   │ CHART: Entity type split      │
│  in selected country         │ for this country              │
│  (bar: kolik CASPs per svc) │ (bank vs crypto vs...)        │
├──────────────────────────────┴───────────────────────────────┤
│  TABLE: CASPs aktivní v dané zemi                            │
│  ┌──────┬────────┬──────┬────────┬─────────┬────────┬──────┐│
│  │ Název│ Typ    │ Země │ Služby │ Segment │Produkt │ Web  ││
│  ├──────┼────────┼──────┼────────┼─────────┼────────┼──────┤│
│  │Bybit │crypto  │ AT   │a,c,d,j│ retail  │exchange│ link ││
│  │...   │        │      │        │         │        │      ││
│  └──────┴────────┴──────┴────────┴─────────┴────────┴──────┘│
│  Filtry: [Entity type ▼] [Service ▼] [Segment ▼]            │
│  Řazení: kliknutí na header sloupce                          │
│  Export: [CSV] [JSON]                                        │
└──────────────────────────────────────────────────────────────┘
```

### Tab 3: CASP Explorer

Detail jednotlivých CASPs s možností srovnání.

```
┌──────────────────────────────────────────────────────────────┐
│  SEARCH: [🔍 Hledat CASP podle názvu nebo LEI...          ]  │
│  FILTERS: [Entity type ▼] [Home country ▼] [Services ▼]     │
│           [Segment ▼] [Min services: slider]                 │
├──────────────────────────────────────────────────────────────┤
│  TABLE: Všechny CASPs (sortable, filterable)                 │
│  ┌──────┬──────┬──────┬──────┬─────┬────────┬──────┬───────┐│
│  │☐ Název│Typ  │Země  │Služby│Pass.│Segment │Prodkt│Conf.  ││
│  ├──────┼──────┼──────┼──────┼─────┼────────┼──────┼───────┤│
│  │☐ ... │      │      │badges│count│tags    │tags  │●●●    ││
│  └──────┴──────┴──────┴──────┴─────┴────────┴──────┴───────┘│
│  [Compare selected (max 4)]                                  │
├──────────────────────────────────────────────────────────────┤
│  COMPARISON VIEW (po kliknutí na Compare):                   │
│  Side-by-side karty s radar chartem služeb a pokrytím        │
├──────────────────────────────────────────────────────────────┤
│  DETAIL VIEW (po kliknutí na řádek):                         │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ Bybit EU GmbH                                            ││
│  │ LEI: 5299005V5GBSN2A4C303  |  Typ: crypto_native        ││
│  │ Popis: Globální kryptoměnová burza zaměřená na...        ││
│  │ Služby: [a] [c] [d] [f] [j]  (5/10)                     ││
│  │ Segmenty: retail, professional                           ││
│  │ Produkty: spot_exchange, derivatives, custody             ││
│  │ Passporting: 26 zemí (mapa miniatura)                    ││
│  │ Confidence: ●●● high                                     ││
│  │ Web: bybit.eu ↗                                          ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

### Tab 4: Market Sizing

Analýza tržního potenciálu.

```
┌──────────────────────────────────────────────────────────────┐
│  [ Dropdown: Vyberte zemi / EU celkem ▼ ]                    │
├──────────────────────────────┬───────────────────────────────┤
│  KPI KARTY pro vybranou zemi │  CHART: Tržní potenciál       │
│  ┌────────┐ ┌────────┐      │  per service (bubble chart)   │
│  │Uživatel│ │Objem   │      │  x = počet CASPs              │
│  │550 tis │ │€25 mld │      │  y = est. market size          │
│  └────────┘ └────────┘      │  size = growth rate            │
│  ┌────────┐ ┌────────┐      │                               │
│  │Adopce  │ │CASPs   │      │                               │
│  │5.2%    │ │74      │      │                               │
│  └────────┘ └────────┘      │                               │
├──────────────────────────────┼───────────────────────────────┤
│  TABLE: Service breakdown    │  CHART: Competition density   │
│  per country                 │  (CASPs per €1B market)       │
│  ┌──────┬──────┬──────┬────┐│                               │
│  │Služba│CASPs│Market│Gap ││                               │
│  │  a   │ 52  │€15B  │low ││  Indikátor: hodně CASPs +     │
│  │  h   │  3  │€2B   │HIGH││  malý trh = nasyceno           │
│  │  i   │  5  │€3B   │HIGH││  málo CASPs + velký trh =     │
│  └──────┴──────┴──────┴────┘│  příležitost                  │
├──────────────────────────────┴───────────────────────────────┤
│  INSIGHT PANEL:                                              │
│  "V CZ trhu chybí lokální poskytovatel advisory (h) a        │
│   portfolio managementu (i). 74 passportovaných CASPs        │
│   nabízí primárně exchange a custody služby. Příležitost     │
│   pro specializovaného poskytovatele."                       │
│                                                              │
│  Disclaimer: Tržní odhady vycházejí z [zdroje]. Skutečné    │
│  hodnoty se mohou lišit.                                     │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. Datová kvalita a known issues

### Problémy v CSV, které MUSÍ parser řešit:

| Problém | Příklad | Řešení |
|---------|---------|--------|
| Service code formátování | `a.\tproviding...` vs `a. providing...` | Regex: extrahovat první písmeno a-j |
| Zkrácený text služby | `d. exchange of crypto-assets for other` | Matchovat na první písmeno |
| Nekonzistentní oddělovače | `\|` vs `;` vs `,` | Split na všechny, pak normalizovat |
| Country code case | `Fi` místo `FI` | toUpperCase() |
| GR vs EL pro Řecko | Oba v datech | Standardizovat na jeden (doporučení: použít ISO `GR`) |
| Chybějící `ae_homeMemberState` | 2 záznamy | Odvodit z `ae_lei_cou_code` |
| Encoding issues | `Stra�e` | UTF-8 handling při čtení CSV |
| Nevalidní service code letters | `p`, `r` v datech | Ignorovat / zalogovat warning |
| Website bez https:// | `www.okx.com` | Doplnit `https://` |

---

## 7. Build příkazy

```bash
# Instalace
npm install

# Krok 1-4: Data pipeline (vyžaduje ANTHROPIC_API_KEY pro krok 3)
npm run build:data

# Nebo jednotlivé kroky:
npm run build:parse          # Krok 1
npm run build:scrape         # Krok 2 (pomalé, ~5 min)
npm run build:classify       # Krok 3 (vyžaduje API key, ~150 calls)
npm run build:merge          # Krok 4

# Krok 5: Build frontend
npm run build:site

# Vše najednou
npm run build

# Dev server
npm run dev

# Vyčistit cache (force re-scrape/re-classify)
npm run clean:cache
```

**Environment variables:**
```
ANTHROPIC_API_KEY=sk-ant-...    # Povinné pro krok 3
SCRAPE_CONCURRENCY=5            # Volitelné, default 5
LLM_CONCURRENCY=5               # Volitelné, default 5
SKIP_SCRAPE=false               # Přeskočit scraping (použít cache)
SKIP_LLM=false                  # Přeskočit LLM klasifikaci (použít cache)
```

---

## 8. Kritéria kvality a acceptance

### Funkcionální
- [ ] Všech 150 CASPs je zobrazeno a prohledatelných
- [ ] Country view správně rozlišuje registrované vs. passportované CASPs
- [ ] Filtry fungují v kombinaci (entity type + service + country)
- [ ] Service codes jsou správně normalizovány (validace: 10 služeb a-j, žádné duplicity)
- [ ] Tabulky jsou řaditelné dle všech sloupců
- [ ] Comparison view zobrazí max 4 CASPs side-by-side
- [ ] Market sizing zobrazuje disclaimer a zdroje

### Datová kvalita
- [ ] Scraping success rate > 70% (logováno)
- [ ] LLM klasifikace pokrývá 100% CASPs (s fallback na `confidence: low`)
- [ ] Žádné duplicitní LEI v datech
- [ ] Všechny country codes validní ISO 3166-1 alpha-2

### UX
- [ ] Stránka se načte do 2s (bundle < 2MB)
- [ ] Responsivní na šířce ≥ 768px
- [ ] Charty mají tooltips s hodnotami
- [ ] Export do CSV funguje z CASP Explorer a Country View
- [ ] Barvy rozlišují entity_type konzistentně napříč celou aplikací

### Build
- [ ] `npm run build` proběhne bez chyb (s platným API klíčem)
- [ ] Build je idempotentní — opakované spuštění dává stejný výsledek
- [ ] Cache funguje — opakovaný build nepřevolává API/scraper
- [ ] `dist/` je self-contained — funguje po servírování jakýmkoliv static serverem

---

## 9. Rozšíření (out of scope, ale připraveno)

Architektura je navržena tak, aby umožnila budoucí rozšíření:

1. **GLEIF API enrichment** — přidat do pipeline krok 2b pro ownership strukturu z LEI registru
2. **Automatický update** — GitHub Action, které periodicky stahuje nový CSV z ESMA a rebuild
3. **Srovnání v čase** — verzování `app.json` pro diff mezi snapshoty registru
4. **CoinGecko volumes** — přidat runtime API call (optional, degraduje gracefully)
5. **AI insights** — Claude API call z frontendu pro generování insights per country/service

---

## 10. Poznámky pro implementátora

- **Service code normalizace je kritická** — špatná normalizace rozbije celou analytiku. Doporučuji napsat testy.
- **LLM prompt je navržen pro structured output** — validovat JSON response, retry při parse error (max 2x).
- **Market sizing data budou zpočátku placeholder** — struktura je důležitější než přesnost čísel. Čísla se upřesní později.
- **Encoding:** CSV používá UTF-8 s BOM, některé adresy mají broken encoding (např. `Stra�e`). Při scrapingu mohou weby být v libovolném jazyce — LLM to zvládne.
- **Vizuální identita:** Použít modro-šedou paletu vhodnou pro finanční/regulatorní kontext. Krypto-native = oranžová/žlutá, banky = modrá, hybrid = zelená.
