let currentJobId = null;
let pollInterval = null;
let currentData = [];

document.addEventListener('DOMContentLoaded', () => {
  loadStates();
  setupEventListeners();
});

let stateCities = {};

async function loadStates() {
  try {
    const res = await fetch('/api/states');
    const states = await res.json();
    const select = document.getElementById('stateSelect');
    select.innerHTML = '<option value="">-- Select a state --</option>';
    states.sort().forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      select.appendChild(opt);
    });
  } catch {
    showToast('Failed to load states list');
  }
}

function setupEventListeners() {
  document.getElementById('stateSelect').addEventListener('change', onStateChange);
  document.getElementById('startBtn').addEventListener('click', startScraping);
  document.getElementById('downloadBtn').addEventListener('click', downloadExcel);
  document.getElementById('cancelBtn').addEventListener('click', cancelScraping);
  document.getElementById('selectAllBtn').addEventListener('click', () => selectAllCities(true));
  document.getElementById('deselectAllBtn').addEventListener('click', () => selectAllCities(false));
  document.getElementById('nicheInput').addEventListener('input', onNicheChange);
  document.querySelectorAll('.niche-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('nicheInput').value = btn.dataset.niche;
      document.querySelectorAll('.niche-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateStartBtn();
    });
  });
}

async function onStateChange() {
  const state = document.getElementById('stateSelect').value;
  document.getElementById('startBtn').disabled = !state;
  const cityStep = document.getElementById('cityStep');
  const nicheStep = document.getElementById('nicheStep');
  const goStep = document.getElementById('goStep');

  if (!state) {
    cityStep.style.display = 'none';
    nicheStep.style.display = 'none';
    goStep.style.display = 'none';
    return;
  }

  try {
    const res = await fetch('/api/cities?state=' + encodeURIComponent(state));
    const cities = await res.json();
    if (!cities || cities.length === 0) { cityStep.style.display = 'none'; return; }

    stateCities[state] = cities;
    const container = document.getElementById('cityCheckboxes');
    container.innerHTML = cities.map(c =>
      `<label class="city-checkbox"><input type="checkbox" value="${c}" checked> ${c}</label>`
    ).join('');
    updateCityCount();
    cityStep.style.display = 'flex';
    nicheStep.style.display = 'flex';
    goStep.style.display = 'flex';
    updateStartBtn();
  } catch {
    cityStep.style.display = 'none';
  }
}

function selectAllCities(checked) {
  document.querySelectorAll('#cityCheckboxes input[type="checkbox"]').forEach(cb => cb.checked = checked);
  updateCityCount();
}

function updateCityCount() {
  const checked = document.querySelectorAll('#cityCheckboxes input:checked').length;
  document.getElementById('cityCount').textContent = `(${checked} selected)`;
  updateEstimate();
}

let maxLeads = 1000;

async function updateEstimate() {
  try {
    const res = await fetch('/api/estimate');
    const data = await res.json();
    if (data.maxLeads) maxLeads = data.maxLeads;
  } catch {}
  const cities = getSelectedCities().length;
  const niche = document.getElementById('nicheInput').value.trim() || 'businesses';
  const box = document.getElementById('estimateBox');
  const text = document.getElementById('estimateText');
  if (!cities || !niche) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  const perCity = Math.round(maxLeads / cities);
  text.innerHTML = `<strong>${maxLeads.toLocaleString()}</strong> max leads from <strong>${cities}</strong> ${cities === 1 ? 'city' : 'cities'} &middot; ~${perCity} per city &middot; <span class="estimate-dedup">no duplicates</span>`;
}

function onNicheChange() {
  document.querySelectorAll('.niche-chip').forEach(b => b.classList.remove('active'));
  updateStartBtn();
}

function updateStartBtn() {
  const state = document.getElementById('stateSelect').value;
  const cities = getSelectedCities();
  const niche = document.getElementById('nicheInput').value.trim();
  document.getElementById('startBtn').disabled = !state || cities.length === 0 || !niche;
  updateEstimate();
}

function getSelectedCities() {
  return Array.from(document.querySelectorAll('#cityCheckboxes input:checked')).map(cb => cb.value);
}

async function startScraping() {
  const state = document.getElementById('stateSelect').value;
  const cities = getSelectedCities();
  const niche = document.getElementById('nicheInput').value.trim() || 'businesses';
  if (!state || cities.length === 0 || !niche) { showToast('Complete all steps first'); return; }

  setUIState('scraping');

  document.getElementById('progressSection').classList.add('active');
  document.getElementById('downloadBtn').style.display = 'none';
  document.getElementById('cancelBtn').style.display = 'inline-block';
  document.getElementById('logContainer').innerHTML = '<div class="log-entry info">Starting scrape...</div>';

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, cities, niche })
    });

    const data = await res.json();

    if (data.error) {
      showToast('Error: ' + data.error);
      setUIState('idle');
      return;
    }

    currentJobId = data.jobId;
    addLog('info', `Scraping "${niche}" in ${state} (${data.totalCities} cities)`);
    updateCityStatus(data.totalCities);

    pollInterval = setInterval(() => pollProgress(), 1500);
  } catch (err) {
    showToast('Failed to start scrape: ' + err.message);
    setUIState('idle');
  }
}

async function pollProgress() {
  if (!currentJobId) return;

  try {
    const res = await fetch(`/api/progress/${currentJobId}`);
    const data = await res.json();

    if (data.status === 'not_found') {
      clearInterval(pollInterval);
      setUIState('idle');
      return;
    }

    document.getElementById('statProgress').textContent = data.progress + '%';
    document.getElementById('statCities').textContent = `${data.completedCities || 0}/${data.totalCities || 0}`;
    document.getElementById('statBusinesses').textContent = data.totalBusinesses || 0;
    document.getElementById('progressBar').style.width = data.progress + '%';
    document.getElementById('statElapsed').textContent = formatTime(data.elapsedSecs);
    document.getElementById('statEta').textContent = data.etaSecs != null ? formatTime(data.etaSecs) : '--';

    if (data.cities) {
      updateCityStatusFromList(data.cities, data.completedCities || 0);
    }

    if (data.status === 'running') {
      document.getElementById('statStatus').textContent = 'Scraping...';
      document.getElementById('statStatus').style.color = '#3182ce';
    } else if (data.status === 'completed') {
      document.getElementById('statStatus').textContent = 'Completed!';
      document.getElementById('statStatus').style.color = '#276749';
      currentData = data;
      clearInterval(pollInterval);

      if (data.filename) {
        document.getElementById('downloadBtn').style.display = 'inline-block';
      }
      document.getElementById('cancelBtn').style.display = 'none';
      setUIState('completed');
      showToast(`Done! ${data.totalBusinesses} leads found.`);
    } else if (data.status === 'error') {
      document.getElementById('statStatus').textContent = 'Error';
      document.getElementById('statStatus').style.color = '#9b2c2c';
      clearInterval(pollInterval);
      document.getElementById('cancelBtn').style.display = 'none';
      setUIState('idle');
      showToast('Scraping encountered an error.');
    } else if (data.status === 'cancelled') {
      document.getElementById('statStatus').textContent = 'Cancelled';
      document.getElementById('statStatus').style.color = '#9b2c2c';
      currentData = data;
      clearInterval(pollInterval);
      document.getElementById('cancelBtn').style.display = 'none';
      if (data.filename) {
        document.getElementById('downloadBtn').style.display = 'inline-block';
        showToast(`Cancelled. ${data.totalBusinesses} leads saved.`);
      } else {
        setUIState('idle');
        showToast('No data to download.');
      }
    }

    if (data.logs) {
      const container = document.getElementById('logContainer');
      container.innerHTML = data.logs.map(l =>
        `<div class="log-entry ${l.type}">${escapeHtml(l.message)}</div>`
      ).join('');
      container.scrollTop = container.scrollHeight;
    }
  } catch {
  }
}

async function downloadExcel() {
  if (!currentJobId) return;
  window.location.href = `/api/download/${currentJobId}`;
  showToast('Downloading...');
}

async function cancelScraping() {
  if (!currentJobId) return;
  try {
    await fetch(`/api/cancel/${currentJobId}`, { method: 'POST' });
  } catch {}
  showToast('Cancelling, generating partial Excel...');
}

function updateCityStatus(total) {
  const container = document.getElementById('cityStatus');
  container.innerHTML = '';
}

function updateCityStatusFromList(cities, completedCities) {
  const container = document.getElementById('cityStatus');
  let html = '';
  cities.forEach((city, i) => {
    let statusClass = 'pending';
    if (i < completedCities) statusClass = 'done';
    else if (i === completedCities) statusClass = 'scraping';
    html += `<span class="${statusClass}">${city}</span> `;
  });
  container.innerHTML = html;
}

function setUIState(state) {
  const btn = document.getElementById('startBtn');
  const select = document.getElementById('stateSelect');
  const group = document.getElementById('citySelectGroup');

  if (state === 'scraping') {
    btn.disabled = true;
    btn.textContent = 'Scraping...';
    select.disabled = true;
    document.querySelectorAll('.city-checkbox input, .niche-chip, #nicheInput').forEach(el => el.disabled = true);
  } else {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">&#9654;</span> Start Scraping';
    select.disabled = false;
    document.querySelectorAll('.city-checkbox input, .niche-chip, #nicheInput').forEach(el => el.disabled = false);
  }
}

function addLog(type, message) {
  const container = document.getElementById('logContainer');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = message;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(secs) {
  if (secs == null || isNaN(secs)) return '--';
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}
