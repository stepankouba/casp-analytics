/* ── Charts Module ────────────────────────────────────────── */
window.Charts = (() => {
  const ENTITY_COLORS = {
    bank: '#3b82f6',
    crypto_native: '#f59e0b',
    hybrid: '#10b981',
    investment_firm: '#8b5cf6',
    payment_institution: '#ec4899',
    other: '#6b7280',
  };

  const ENTITY_LABELS = {
    bank: 'Bank',
    crypto_native: 'Crypto Native',
    hybrid: 'Hybrid',
    investment_firm: 'Investment Firm',
    payment_institution: 'Payment Institution',
    other: 'Other',
  };

  const chartInstances = {};

  function destroy(id) {
    if (chartInstances[id]) {
      chartInstances[id].destroy();
      delete chartInstances[id];
    }
  }

  function create(id, config) {
    destroy(id);
    const ctx = document.getElementById(id);
    if (!ctx) return null;
    chartInstances[id] = new Chart(ctx, config);
    return chartInstances[id];
  }

  /* ── Overview: CASPs by home country (bar) ── */
  function countryBar(casps, countries) {
    const counts = {};
    casps.forEach(c => { counts[c.home_country] = (counts[c.home_country] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(([code]) => countries[code]?.name || code);
    const values = sorted.map(([, v]) => v);

    return create('chartCountryBar', {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Registered CASPs',
          data: values,
          backgroundColor: '#3b82f6',
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 5 } },
          x: { ticks: { font: { size: 11 } } }
        }
      }
    });
  }

  /* ── Overview: Entity type donut ── */
  function entityDonut(casps) {
    const counts = {};
    casps.forEach(c => { counts[c.entity_type] = (counts[c.entity_type] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

    return create('chartEntityDonut', {
      type: 'doughnut',
      data: {
        labels: sorted.map(([k]) => ENTITY_LABELS[k] || k),
        datasets: [{
          data: sorted.map(([, v]) => v),
          backgroundColor: sorted.map(([k]) => ENTITY_COLORS[k] || '#6b7280'),
          borderWidth: 2,
          borderColor: '#fff',
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { font: { size: 12 }, padding: 12 } }
        }
      }
    });
  }

  /* ── Overview: Service frequency (horizontal bar) ── */
  function serviceBar(casps, servicesRef) {
    const counts = {};
    casps.forEach(c => c.services.forEach(s => { counts[s] = (counts[s] || 0) + 1; }));
    const codes = Object.keys(servicesRef).sort();
    const labels = codes.map(c => `${c}. ${servicesRef[c].name}`);
    const values = codes.map(c => counts[c] || 0);

    return create('chartServiceBar', {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'CASPs offering this service',
          data: values,
          backgroundColor: '#6366f1',
          borderRadius: 4,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true },
          y: { ticks: { font: { size: 11 } } }
        }
      }
    });
  }

  /* ── Overview: Auth timeline (line) ── */
  function timeline(casps) {
    const months = {};
    casps.forEach(c => {
      if (!c.auth_date) return;
      const m = c.auth_date.slice(0, 7); // YYYY-MM
      months[m] = (months[m] || 0) + 1;
    });
    const sorted = Object.entries(months).sort((a, b) => a[0].localeCompare(b[0]));
    // Cumulative
    let cum = 0;
    const cumulative = sorted.map(([, v]) => { cum += v; return cum; });

    return create('chartTimeline', {
      type: 'line',
      data: {
        labels: sorted.map(([m]) => m),
        datasets: [
          {
            label: 'New authorisations',
            data: sorted.map(([, v]) => v),
            backgroundColor: 'rgba(99,102,241,.2)',
            borderColor: '#6366f1',
            fill: true,
            tension: .3,
            yAxisID: 'y',
          },
          {
            label: 'Cumulative',
            data: cumulative,
            borderColor: '#f59e0b',
            borderDash: [5, 3],
            tension: .3,
            pointRadius: 2,
            yAxisID: 'y1',
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { font: { size: 11 } } } },
        scales: {
          y: { beginAtZero: true, position: 'left', title: { display: true, text: 'New' } },
          y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Cumulative' } },
          x: { ticks: { font: { size: 10 } } }
        }
      }
    });
  }

  /* ── Overview: Passporting top targets (bar) ── */
  function passportBar(casps, countries) {
    const counts = {};
    casps.forEach(c => c.passporting_countries.forEach(p => { counts[p] = (counts[p] || 0) + 1; }));
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20);

    return create('chartPassportBar', {
      type: 'bar',
      data: {
        labels: sorted.map(([c]) => countries[c]?.name || c),
        datasets: [{
          label: 'CASPs passporting into country',
          data: sorted.map(([, v]) => v),
          backgroundColor: '#10b981',
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true },
          x: { ticks: { font: { size: 10 }, maxRotation: 45 } }
        }
      }
    });
  }

  /* ── Country: Services available (bar) ── */
  function countryServices(canvasId, casps, servicesRef) {
    const counts = {};
    casps.forEach(c => c.services.forEach(s => { counts[s] = (counts[s] || 0) + 1; }));
    const codes = Object.keys(servicesRef).sort();

    return create(canvasId, {
      type: 'bar',
      data: {
        labels: codes.map(c => `${c}. ${servicesRef[c].name}`),
        datasets: [{
          label: 'CASPs',
          data: codes.map(c => counts[c] || 0),
          backgroundColor: '#6366f1',
          borderRadius: 4,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true } }
      }
    });
  }

  /* ── Country: Entity type split (donut) ── */
  function countryEntity(canvasId, casps) {
    const counts = {};
    casps.forEach(c => { counts[c.entity_type] = (counts[c.entity_type] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

    return create(canvasId, {
      type: 'doughnut',
      data: {
        labels: sorted.map(([k]) => ENTITY_LABELS[k] || k),
        datasets: [{
          data: sorted.map(([, v]) => v),
          backgroundColor: sorted.map(([k]) => ENTITY_COLORS[k] || '#6b7280'),
          borderWidth: 2,
          borderColor: '#fff',
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } }
      }
    });
  }

  /* ── Market: Bubble chart (services) ── */
  function marketBubble(serviceData, servicesRef) {
    // serviceData: array of { code, casps, market_size, growth_rate }
    const colors = ['#3b82f6','#f59e0b','#10b981','#8b5cf6','#ec4899','#6366f1','#ef4444','#14b8a6','#f97316','#64748b'];

    return create('chartMarketBubble', {
      type: 'bubble',
      data: {
        datasets: serviceData.map((d, i) => ({
          label: `${d.code}. ${servicesRef[d.code]?.name || d.code}`,
          data: [{
            x: d.casps,
            y: d.market_size / 1e9,
            r: Math.max(6, Math.min(30, d.growth_rate * 80)),
          }],
          backgroundColor: colors[i % colors.length] + '99',
          borderColor: colors[i % colors.length],
        }))
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 10 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const d = serviceData[ctx.datasetIndex];
                return `${d.code}. ${servicesRef[d.code]?.name}: ${d.casps} CASPs, ${fmtEur(d.market_size)}, +${(d.growth_rate*100).toFixed(0)}% YoY`;
              }
            }
          }
        },
        scales: {
          x: { title: { display: true, text: 'Number of CASPs' }, beginAtZero: true },
          y: { title: { display: true, text: 'Market size (EUR billions)' }, beginAtZero: true }
        }
      }
    });
  }

  /* ── Market: Competition density (horizontal bar) ── */
  function competitionDensity(serviceData, servicesRef) {
    const sorted = [...serviceData].sort((a, b) => b.density - a.density);

    return create('chartCompetitionDensity', {
      type: 'bar',
      data: {
        labels: sorted.map(d => `${d.code}. ${servicesRef[d.code]?.name || d.code}`),
        datasets: [{
          label: 'CASPs per EUR 1B market',
          data: sorted.map(d => Math.round(d.density * 100) / 100),
          backgroundColor: sorted.map(d => d.density > 1 ? '#ef4444' : d.density > 0.1 ? '#f59e0b' : '#10b981'),
          borderRadius: 4,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, title: { display: true, text: 'CASPs per EUR 1B' } } }
      }
    });
  }

  function fmtEur(v) {
    if (v >= 1e12) return `EUR ${(v/1e12).toFixed(1)}T`;
    if (v >= 1e9) return `EUR ${(v/1e9).toFixed(1)}B`;
    if (v >= 1e6) return `EUR ${(v/1e6).toFixed(0)}M`;
    return `EUR ${v.toLocaleString()}`;
  }

  return {
    countryBar, entityDonut, serviceBar, timeline, passportBar,
    countryServices, countryEntity,
    marketBubble, competitionDensity,
    ENTITY_COLORS, ENTITY_LABELS, fmtEur,
    destroy,
  };
})();
