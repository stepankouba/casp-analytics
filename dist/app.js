/* ── MiCA CASP Analytics — Main App ───────────────────────── */
(async () => {
  // ── Load data ──
  const resp = await fetch('data/app.json');
  const data = await resp.json();
  const { casps, countries, market_sizing, services_reference, metadata } = data;

  // ── Header meta ──
  document.getElementById('headerMeta').textContent =
    `${metadata.total_casps} CASPs | Generated: ${metadata.generated_at.slice(0, 10)} | Source: ${metadata.source}`;

  // ── Tab navigation ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      gtag('event', 'view_tab', { tab_name: tab.dataset.tab });
    });
  });

  // ════════════════════════════════════════════════════════════
  //  TAB 1: OVERVIEW
  // ════════════════════════════════════════════════════════════
  {
    // KPIs
    const homeCountries = new Set(casps.map(c => c.home_country));
    const avgServices = (casps.reduce((s, c) => s + c.services.length, 0) / casps.length).toFixed(1);
    const bankCount = casps.filter(c => c.entity_type === 'bank').length;

    document.getElementById('overviewKpis').innerHTML = [
      kpi(casps.length, 'Total CASPs'),
      kpi(homeCountries.size, 'Home Countries'),
      kpi(avgServices, 'Avg Services'),
      kpi(bankCount, 'Banks'),
    ].join('');

    // Charts
    Charts.countryBar(casps, countries);
    Charts.entityDonut(casps);
    Charts.serviceBar(casps, services_reference);
    Charts.timeline(casps);
    Charts.passportBar(casps, countries);
  }

  // ════════════════════════════════════════════════════════════
  //  TAB 2: COUNTRY VIEW
  // ════════════════════════════════════════════════════════════
  {
    const countrySelect = document.getElementById('countrySelect');
    const toggleBtns = document.querySelectorAll('.toggle-group .toggle');
    let currentMode = 'both';

    // Populate country dropdown sorted by total CASPs
    const countryOptions = Object.entries(countries)
      .filter(([, v]) => v.total_casps > 0)
      .sort((a, b) => b[1].total_casps - a[1].total_casps)
      .map(([code, v]) => ({ value: code, label: `${v.name} (${v.total_casps})` }));

    Filters.populateSelect(countrySelect, countryOptions, 'Select a country...');

    // Toggle buttons
    toggleBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        toggleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = btn.dataset.mode;
        renderCountryView();
      });
    });

    countrySelect.addEventListener('change', () => {
      renderCountryView();
      if (countrySelect.value) {
        gtag('event', 'select_country', { view: 'country_view', country: countrySelect.value });
      }
    });

    // Filter controls
    const entityFilter = document.getElementById('countryFilterEntity');
    const serviceFilter = document.getElementById('countryFilterService');
    populateEntityFilter(entityFilter);
    populateServiceFilter(serviceFilter);
    entityFilter.addEventListener('change', renderCountryView);
    serviceFilter.addEventListener('change', renderCountryView);

    // Export
    document.getElementById('countryExportCsv').addEventListener('click', () => {
      const filtered = getCountryFilteredCasps();
      const code = countrySelect.value;
      Filters.exportCsv(filtered, `casps_${code || 'all'}.csv`);
    });

    function getCountryFilteredCasps() {
      const code = countrySelect.value;
      if (!code) return [];
      return Filters.filterCasps(casps, {
        country: code,
        mode: currentMode,
        entityType: entityFilter.value || undefined,
        service: serviceFilter.value || undefined,
      });
    }

    function renderCountryView() {
      const code = countrySelect.value;
      if (!code) return;

      const cMeta = countries[code];
      const mkt = market_sizing.per_country[code];
      const filtered = getCountryFilteredCasps();

      // Summary card
      const registered = casps.filter(c => c.home_country === code).length;
      const passported = casps.filter(c => c.passporting_countries.includes(code)).length;

      document.getElementById('countrySummary').innerHTML = `
        <h3>${cMeta.name} ${cMeta.name_local !== cMeta.name ? `(${cMeta.name_local})` : ''}</h3>
        <div class="country-summary-grid">
          <div class="stat"><div class="stat-value">${registered}</div><div class="stat-label">Registered</div></div>
          <div class="stat"><div class="stat-value">${passported}</div><div class="stat-label">Passported</div></div>
          <div class="stat"><div class="stat-value">${registered + passported}</div><div class="stat-label">Total</div></div>
          ${mkt ? `
          <div class="stat"><div class="stat-value">${Charts.fmtEur(mkt.estimated_annual_volume_eur)}</div><div class="stat-label">Est. Annual Volume</div></div>
          <div class="stat"><div class="stat-value">${mkt.crypto_adoption_pct}%</div><div class="stat-label">Adoption</div></div>
          <div class="stat"><div class="stat-value">${(mkt.estimated_users / 1000).toFixed(0)}K</div><div class="stat-label">Est. Users</div></div>
          ` : ''}
          <div class="stat"><div class="stat-value">${Charts.fmtEur(cMeta.gdp_eur)}</div><div class="stat-label">GDP</div></div>
        </div>
      `;

      // Charts
      Charts.countryServices('chartCountryServices', filtered, services_reference);
      Charts.countryEntity('chartCountryEntity', filtered);

      // Table
      renderSortableTable('countryTable', filtered);
    }

    // Sort handling for country table
    setupTableSort('countryTable', () => getCountryFilteredCasps(), renderCountryTableBody);
  }

  // ════════════════════════════════════════════════════════════
  //  TAB 3: CASP EXPLORER
  // ════════════════════════════════════════════════════════════
  {
    const searchInput = document.getElementById('explorerSearch');
    const entityFilter = document.getElementById('explorerFilterEntity');
    const countryFilter = document.getElementById('explorerFilterCountry');
    const serviceFilter = document.getElementById('explorerFilterService');

    populateEntityFilter(entityFilter);
    populateServiceFilter(serviceFilter);

    // Country dropdown for explorer
    const allCountries = [...new Set(casps.map(c => c.home_country))].sort();
    Filters.populateSelect(countryFilter,
      allCountries.map(c => ({ value: c, label: `${countries[c]?.name || c} (${c})` })),
      'All countries'
    );

    let searchDebounce;
    [searchInput, entityFilter, countryFilter, serviceFilter].forEach(el => {
      el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', renderExplorer);
    });
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        if (searchInput.value.length >= 2) {
          gtag('event', 'search', { search_term: searchInput.value });
        }
      }, 1000);
    });

    document.getElementById('explorerExportCsv').addEventListener('click', () => {
      Filters.exportCsv(getExplorerFiltered(), 'casps_export.csv');
    });

    function getExplorerFiltered() {
      return Filters.filterCasps(casps, {
        search: searchInput.value,
        entityType: entityFilter.value || undefined,
        country: countryFilter.value || undefined,
        service: serviceFilter.value || undefined,
        mode: 'registered',
      });
    }

    function renderExplorer() {
      const filtered = getExplorerFiltered();
      document.getElementById('explorerCount').textContent = `${filtered.length} of ${casps.length} CASPs`;
      renderExplorerTableBody(filtered);
    }

    // Initial render
    renderExplorer();

    // Sort
    setupTableSort('explorerTable', getExplorerFiltered, renderExplorerTableBody);

    // Detail view on row click
    document.getElementById('explorerTable').addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-lei]');
      if (!row) return;
      const casp = casps.find(c => c.lei === row.dataset.lei);
      if (casp) showDetail(casp);
    });
  }

  // ════════════════════════════════════════════════════════════
  //  TAB 4: MARKET SIZING
  // ════════════════════════════════════════════════════════════
  {
    const marketCountrySelect = document.getElementById('marketCountrySelect');

    const countryOptions = [
      { value: 'EU', label: 'EU Total' },
      ...Object.entries(countries)
        .filter(([code]) => market_sizing.per_country[code])
        .sort((a, b) => a[1].name.localeCompare(b[1].name))
        .map(([code, v]) => ({ value: code, label: v.name }))
    ];
    Filters.populateSelect(marketCountrySelect, countryOptions);

    marketCountrySelect.addEventListener('change', () => {
      renderMarket();
      gtag('event', 'select_country', { view: 'market_sizing', country: marketCountrySelect.value });
    });
    renderMarket();

    function renderMarket() {
      const code = marketCountrySelect.value;
      const isEU = code === 'EU';
      const mkt = isEU ? market_sizing.eu_totals : market_sizing.per_country[code];

      if (!mkt) return;

      // KPIs
      const relevantCasps = isEU ? casps :
        casps.filter(c => c.home_country === code || c.passporting_countries.includes(code));

      document.getElementById('marketKpis').innerHTML = [
        kpi(isEU ? `${(mkt.crypto_users_estimated / 1e6).toFixed(0)}M` : `${(mkt.estimated_users / 1000).toFixed(0)}K`, 'Est. Users'),
        kpi(Charts.fmtEur(isEU ? mkt.annual_trading_volume_eur : mkt.estimated_annual_volume_eur), 'Est. Volume'),
        kpi(isEU ? '-' : `${mkt.crypto_adoption_pct}%`, 'Adoption'),
        kpi(relevantCasps.length, 'Active CASPs'),
      ].join('');

      // Service breakdown data
      const serviceData = Object.keys(services_reference).map(code_s => {
        const svc = market_sizing.per_service_eu[code_s];
        const caspCount = relevantCasps.filter(c => c.services.includes(code_s)).length;
        const marketSize = svc?.estimated_market_size_eur || 0;
        const growth = svc?.growth_rate_yoy || 0;
        const density = marketSize > 0 ? caspCount / (marketSize / 1e9) : 0;

        return { code: code_s, casps: caspCount, market_size: marketSize, growth_rate: growth, density };
      });

      // Charts
      Charts.marketBubble(serviceData, services_reference);
      Charts.competitionDensity(serviceData, services_reference);

      // Table
      const tbody = document.querySelector('#marketTable tbody');
      tbody.innerHTML = serviceData.map(d => {
        const gap = d.density < 0.05 ? 'HIGH' : d.density < 0.5 ? 'Medium' : 'Low';
        const gapClass = gap === 'HIGH' ? 'gap-high' : gap === 'Medium' ? 'gap-medium' : 'gap-low';
        return `<tr>
          <td>${d.code}. ${services_reference[d.code]?.name || d.code}</td>
          <td>${d.casps}</td>
          <td>${Charts.fmtEur(d.market_size)}</td>
          <td>+${(d.growth_rate * 100).toFixed(0)}%</td>
          <td>${d.density.toFixed(2)}</td>
          <td class="${gapClass}">${gap}</td>
        </tr>`;
      }).join('');

      // Insight
      const highGap = serviceData.filter(d => d.density < 0.05).map(d =>
        `${services_reference[d.code]?.name} (${d.code})`
      );
      const saturated = serviceData.filter(d => d.density > 1).map(d =>
        `${services_reference[d.code]?.name} (${d.code})`
      );

      const countryName = isEU ? 'the EU market' : countries[code]?.name || code;
      let insight = `<h3>Market Insight</h3><p>`;
      if (highGap.length > 0) {
        insight += `In ${countryName}, there is significant opportunity in: <strong>${highGap.join(', ')}</strong> — these services have large estimated markets but few providers. `;
      }
      if (saturated.length > 0) {
        insight += `Competition is highest in: <strong>${saturated.join(', ')}</strong> — many CASPs relative to market size. `;
      }
      if (highGap.length === 0 && saturated.length === 0) {
        insight += `${countryName} shows a balanced competitive landscape across services. `;
      }
      insight += `${relevantCasps.length} CASPs are active in this market.</p>`;
      document.getElementById('marketInsight').innerHTML = insight;
    }
  }

  // ════════════════════════════════════════════════════════════
  //  SHARED HELPERS
  // ════════════════════════════════════════════════════════════

  function kpi(value, label) {
    return `<div class="kpi"><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div>`;
  }

  function populateEntityFilter(el) {
    const types = [...new Set(casps.map(c => c.entity_type))].sort();
    Filters.populateSelect(el,
      types.map(t => ({ value: t, label: Charts.ENTITY_LABELS[t] || t })),
      'All entity types'
    );
  }

  function populateServiceFilter(el) {
    Filters.populateSelect(el,
      Object.keys(services_reference).sort().map(c => ({ value: c, label: `${c}. ${services_reference[c].name}` })),
      'All services'
    );
  }

  function renderSortableTable(tableId, data) {
    if (tableId === 'countryTable') renderCountryTableBody(data);
    else if (tableId === 'explorerTable') renderExplorerTableBody(data);
  }

  function renderCountryTableBody(data) {
    const tbody = document.querySelector('#countryTable tbody');
    tbody.innerHTML = data.map(c => `
      <tr>
        <td><strong>${c.commercial_name || c.legal_name}</strong></td>
        <td>${Filters.renderEntityBadge(c.entity_type)}</td>
        <td>${c.home_country}</td>
        <td>${Filters.renderServiceBadges(c.services)}</td>
        <td>${Filters.renderTags(c.target_segments)}</td>
        <td>${Filters.renderTags(c.primary_products?.slice(0, 3))}</td>
        <td>${Filters.renderWebLink(c.website)}</td>
      </tr>
    `).join('');
  }

  function renderExplorerTableBody(data) {
    const tbody = document.querySelector('#explorerTable tbody');
    tbody.innerHTML = data.map(c => `
      <tr data-lei="${c.lei}">
        <td><strong>${c.commercial_name || c.legal_name}</strong></td>
        <td>${Filters.renderEntityBadge(c.entity_type)}</td>
        <td>${c.home_country}</td>
        <td>${Filters.renderServiceBadges(c.services)}</td>
        <td>${c.passporting_countries.length}</td>
        <td>${Filters.renderTags(c.target_segments)}</td>
        <td>${Filters.renderTags(c.primary_products?.slice(0, 3))}</td>
        <td>${Filters.renderConfidence(c.confidence)}</td>
      </tr>
    `).join('');
  }

  function setupTableSort(tableId, getDataFn, renderFn) {
    document.querySelectorAll(`#${tableId} th[data-sort]`).forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        const sorted = Filters.sortBy(getDataFn(), key);
        renderFn(sorted);
        // Update sort arrows
        document.querySelectorAll(`#${tableId} th[data-sort]`).forEach(h => {
          const arrow = h.querySelector('.sort-arrow') || (() => {
            const s = document.createElement('span');
            s.className = 'sort-arrow';
            h.appendChild(s);
            return s;
          })();
          arrow.textContent = Filters.getSortIndicator(h.dataset.sort);
        });
      });
    });
  }

  function showDetail(c) {
    const detail = document.getElementById('explorerDetail');
    detail.style.display = 'block';
    detail.innerHTML = `
      <button class="detail-close" onclick="this.parentElement.style.display='none'">&times;</button>
      <h3>${c.commercial_name || c.legal_name}</h3>
      <p style="color:var(--c-text-dim);margin-bottom:.75rem;">${c.brief_description || ''}</p>
      <div class="detail-grid">
        <div class="detail-field">
          <label>Legal Name</label>
          <span>${c.legal_name}</span>
        </div>
        <div class="detail-field">
          <label>LEI</label>
          <span style="font-family:monospace;font-size:.8rem;">${c.lei}</span>
        </div>
        <div class="detail-field">
          <label>Entity Type</label>
          <div>${Filters.renderEntityBadge(c.entity_type)}</div>
        </div>
        <div class="detail-field">
          <label>Home Country</label>
          <span>${countries[c.home_country]?.name || c.home_country} (${c.home_country})</span>
        </div>
        <div class="detail-field">
          <label>Services (${c.services.length}/10)</label>
          <div>${c.services.map(s => `<span class="badge badge--service" title="${services_reference[s]?.full || s}">${s}</span>`).join(' ')}</div>
        </div>
        <div class="detail-field">
          <label>Target Segments</label>
          <div>${Filters.renderTags(c.target_segments)}</div>
        </div>
        <div class="detail-field">
          <label>Primary Products</label>
          <div>${Filters.renderTags(c.primary_products)}</div>
        </div>
        <div class="detail-field">
          <label>Passporting (${c.passporting_countries.length} countries)</label>
          <div>${c.passporting_countries.length > 0 ? c.passporting_countries.map(p => `<span class="tag">${p}</span>`).join(' ') : 'None'}</div>
        </div>
        <div class="detail-field">
          <label>Confidence</label>
          <div>${Filters.renderConfidence(c.confidence)} ${c.confidence}</div>
        </div>
        <div class="detail-field">
          <label>Website</label>
          <div>${Filters.renderWebLink(c.website)}</div>
        </div>
        <div class="detail-field">
          <label>Auth Date</label>
          <span>${c.auth_date || '-'}</span>
        </div>
        <div class="detail-field">
          <label>Competent Authority</label>
          <span>${c.competent_authority || '-'}</span>
        </div>
      </div>
    `;
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
})();
