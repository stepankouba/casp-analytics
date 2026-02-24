/* ── Filters & Table Utilities ────────────────────────────── */
window.Filters = (() => {

  /* ── Populate a <select> with options ── */
  function populateSelect(selectEl, options, placeholder) {
    selectEl.innerHTML = '';
    if (placeholder) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = placeholder;
      selectEl.appendChild(opt);
    }
    options.forEach(({ value, label }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      selectEl.appendChild(opt);
    });
  }

  /* ── Filter casps array based on criteria ── */
  function filterCasps(casps, { search, entityType, country, service, mode } = {}) {
    return casps.filter(c => {
      if (search) {
        const q = search.toLowerCase();
        const nameMatch = (c.legal_name + ' ' + (c.commercial_name || '') + ' ' + c.lei).toLowerCase().includes(q);
        if (!nameMatch) return false;
      }
      if (entityType && c.entity_type !== entityType) return false;
      if (service && !c.services.includes(service)) return false;
      if (country) {
        if (mode === 'registered') {
          if (c.home_country !== country) return false;
        } else if (mode === 'passported') {
          if (!c.passporting_countries.includes(country)) return false;
        } else {
          // both
          if (c.home_country !== country && !c.passporting_countries.includes(country)) return false;
        }
      }
      return true;
    });
  }

  /* ── Sort array by key ── */
  let currentSort = { key: null, dir: 1 };

  function sortBy(arr, key) {
    if (currentSort.key === key) {
      currentSort.dir *= -1;
    } else {
      currentSort.key = key;
      currentSort.dir = 1;
    }
    const dir = currentSort.dir;

    return [...arr].sort((a, b) => {
      let va = getNestedValue(a, key);
      let vb = getNestedValue(b, key);
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  function getNestedValue(obj, key) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let val = obj;
      for (const p of parts) val = val?.[p];
      return val;
    }
    return obj[key];
  }

  function getSortIndicator(key) {
    if (currentSort.key !== key) return '';
    return currentSort.dir === 1 ? ' \u25B2' : ' \u25BC';
  }

  /* ── Render table rows ── */
  function renderEntityBadge(type) {
    const label = Charts.ENTITY_LABELS[type] || type;
    return `<span class="badge badge--entity badge--${type}">${label}</span>`;
  }

  function renderServiceBadges(services) {
    return services.map(s => `<span class="badge badge--service">${s}</span>`).join('');
  }

  function renderTags(items) {
    return (items || []).map(t => `<span class="tag">${t.replace(/_/g, ' ')}</span>`).join('');
  }

  function renderConfidence(level) {
    const filled = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
    const cls = `conf-dot--filled-${level}`;
    let html = '<span class="conf-dots">';
    for (let i = 0; i < 3; i++) {
      html += `<span class="conf-dot ${i < filled ? cls : 'conf-dot--empty'}"></span>`;
    }
    html += '</span>';
    return html;
  }

  function renderWebLink(url) {
    if (!url) return '-';
    const display = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `<a href="${url}" target="_blank" rel="noopener">${display.length > 30 ? display.slice(0, 30) + '...' : display}</a>`;
  }

  /* ── CSV export ── */
  function exportCsv(casps, filename) {
    const headers = ['Name', 'Legal Name', 'Type', 'Home Country', 'Services', 'Passporting Countries', 'Segments', 'Products', 'Website', 'LEI', 'Confidence'];
    const rows = casps.map(c => [
      c.commercial_name || c.legal_name,
      c.legal_name,
      c.entity_type,
      c.home_country,
      c.services.join(';'),
      c.passporting_countries.join(';'),
      (c.target_segments || []).join(';'),
      (c.primary_products || []).join(';'),
      c.website || '',
      c.lei,
      c.confidence || '',
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename || 'casps.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return {
    populateSelect, filterCasps, sortBy, getSortIndicator,
    renderEntityBadge, renderServiceBadges, renderTags, renderConfidence, renderWebLink,
    exportCsv,
  };
})();
