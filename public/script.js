let currentJobId = null;
let pollInterval = null;
let currentData = [];
let editingUserId = null;

let token = localStorage.getItem('token');
let userRole = null;

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('loginForm').addEventListener('submit', onLogin);
  if (token) {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if (res.ok) {
      const data = await res.json();
      if (data.onHold) {
        localStorage.removeItem('token');
        token = null;
        document.getElementById('holdModal').style.display = 'flex';
        return;
      }
      userRole = data.role;
      showApp();
      return;
    }
    localStorage.removeItem('token');
  }
  showLogin();
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

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('mainApp').style.display = 'none';
}

async function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  await setAdminNav();
  loadStates();
  setupEventListeners();
  switchTab('scraper');
}

async function setAdminNav() {
  const nav = document.getElementById('adminNav');
  if (!token) { nav.style.display = 'none'; return; }
  try {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if (res.ok) {
      const data = await res.json();
      if (data.onHold) {
        localStorage.removeItem('token');
        token = null;
        showLogin();
        document.getElementById('holdModal').style.display = 'flex';
        return;
      }
      userRole = data.role;
      nav.style.display = userRole === 'admin' ? 'flex' : 'none';
    } else {
      nav.style.display = 'none';
    }
  } catch {
    nav.style.display = 'none';
  }
}

function setupEventListeners() {
  document.getElementById('logoutBtn').addEventListener('click', onLogout);
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
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.getElementById('createUserBtn').addEventListener('click', createUser);
  document.getElementById('saveEditBtn').addEventListener('click', saveEditUser);
}

function switchTab(tab) {
  if (tab !== 'scraper' && userRole !== 'admin') {
    switchTab('scraper');
    return;
  }
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tabScraper').style.display = tab === 'scraper' ? 'block' : 'none';
  document.getElementById('tabDashboard').style.display = tab === 'dashboard' ? 'block' : 'none';
  document.getElementById('tabUsers').style.display = tab === 'users' ? 'block' : 'none';
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'users') loadUsers();
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/admin/stats', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    document.getElementById('dashTotalUsers').textContent = data.totalUsers;
    document.getElementById('dashRegularUsers').textContent = data.regularUsers;
    document.getElementById('dashActiveToday').textContent = data.activeToday;
    document.getElementById('dashScrapesToday').textContent = data.totalScrapesToday;
  } catch {
    showToast('Failed to load dashboard');
  }
}

async function loadUsers() {
  try {
    const res = await fetch('/api/admin/users', { headers: { 'Authorization': 'Bearer ' + token } });
    const users = await res.json();
    const tbody = document.getElementById('usersTableBody');
    tbody.innerHTML = users.map(u => `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td><span class="role-badge role-${u.role}">${u.role}</span></td>
        <td><span class="role-badge role-${u.subscribed ? 'admin' : 'user'}">${u.subscribed ? 'Yes' : 'No'}</span></td>
        <td>${u.scrapeCount || 0}</td>
        <td>${u.lastScrapeDate || 'Never'}</td>
        <td>${formatDate(u.createdAt)}</td>
        <td>${u.role !== 'admin' ? `<button class="btn btn-sm btn-edit" onclick="editUser('${u._id}')">Edit</button><button class="btn btn-sm ${u.subscribed ? 'btn-danger' : 'btn-primary'}" onclick="toggleSubscribe('${u._id}')">${u.subscribed ? 'Unsub' : 'Sub'}</button><button class="btn btn-sm ${u.onHold ? 'btn-success' : 'btn-warning'}" onclick="toggleHold('${u._id}')">${u.onHold ? 'Release' : 'Hold'}</button><button class="btn btn-sm btn-danger" onclick="deleteUser('${u._id}')">Delete</button>` : '--'}</td>
      </tr>
    `).join('');
  } catch {
    showToast('Failed to load users');
  }
}

async function createUser() {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const err = document.getElementById('createUserError');
  if (!username || !password) { err.textContent = 'Enter username and password'; return; }
  err.textContent = '';
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error || 'Failed to create user'; return; }
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    showToast('User created');
    loadUsers();
  } catch {
    err.textContent = 'Connection error';
  }
}

async function editUser(id) {
  try {
    const res = await fetch('/api/admin/users', { headers: { 'Authorization': 'Bearer ' + token } });
    const users = await res.json();
    const user = users.find(u => u._id === id);
    if (!user) { showToast('User not found'); return; }
    editingUserId = id;
    document.getElementById('editUsername').value = user.username;
    document.getElementById('editPassword').value = '';
    document.getElementById('editUserError').textContent = '';
    document.getElementById('editModal').style.display = 'flex';
  } catch {
    showToast('Failed to load user');
  }
}

function closeEditModal() {
  document.getElementById('editModal').style.display = 'none';
  editingUserId = null;
}

async function saveEditUser() {
  const username = document.getElementById('editUsername').value.trim();
  const password = document.getElementById('editPassword').value;
  const err = document.getElementById('editUserError');
  if (!username) { err.textContent = 'Username required'; return; }
  err.textContent = '';
  try {
    const res = await fetch('/api/admin/users/' + editingUserId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ username, password: password || undefined })
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error || 'Failed to update'; return; }
    closeEditModal();
    showToast('User updated');
    loadUsers();
  } catch {
    err.textContent = 'Connection error';
  }
}

async function toggleSubscribe(id) {
  try {
    const res = await fetch('/api/admin/users/' + id + '/subscribe', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) { showToast('Failed to toggle subscription'); return; }
    showToast('Subscription updated');
    loadUsers();
  } catch { showToast('Connection error'); }
}

async function toggleHold(id) {
  try {
    const res = await fetch('/api/admin/users/' + id + '/hold', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) { showToast('Failed to toggle hold'); return; }
    const data = await res.json();
    showToast(data.onHold ? 'User on hold' : 'User released');
    loadUsers();
  } catch { showToast('Connection error'); }
}

async function deleteUser(id) {
  if (!confirm('Delete this user?')) return;
  try {
    const res = await fetch('/api/admin/users/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to delete'); return; }
    showToast('User deleted');
    loadUsers();
  } catch {
    showToast('Connection error');
  }
}

async function onLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');
  if (!username || !password) { err.textContent = 'Enter username and password'; return; }
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  err.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error || 'Login failed'; return; }
    if (data.onHold) {
      document.getElementById('holdModal').style.display = 'flex';
      return;
    }
    token = data.token;
    localStorage.setItem('token', token);
    await showApp();
  } catch { err.textContent = 'Connection error'; }
  finally { btn.disabled = false; btn.textContent = 'Sign In'; }
}

function closeHoldModal() {
  document.getElementById('holdModal').style.display = 'none';
  showLogin();
}

function onLogout() {
  token = null;
  userRole = null;
  localStorage.removeItem('token');
  showLogin();
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').textContent = '';
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
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
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

    if (data.data && data.data.length > 0) {
      currentData = data;
      document.getElementById('liveDataBtn').style.display = 'inline-block';
      if (document.getElementById('liveDataModal').style.display === 'flex') {
        updateLiveTable(data.data);
      }
    }

    if (data.status === 'running') {
      document.getElementById('statStatus').textContent = 'Scraping...';
      document.getElementById('statStatus').style.color = '#0891B2';
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

function formatDate(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  return d.toLocaleDateString();
}

function openLiveData() {
  document.getElementById('liveDataModal').style.display = 'flex';
  updateLiveTable(currentData?.data || []);
}

function closeLiveData() {
  document.getElementById('liveDataModal').style.display = 'none';
}

function updateLiveTable(entries) {
  document.getElementById('liveCount').textContent = `(${entries.length})`;
  const tbody = document.getElementById('liveDataBody');
  tbody.innerHTML = entries.map(e => {
    const esc = escapeHtml;
    return `<tr>
      <td>${esc(e.city || '')}</td>
      <td>${esc(e.company || '')}</td>
      <td>${esc(e.email1 || '')}</td>
      <td>${esc(e.email2 || '')}</td>
      <td>${esc(e.email3 || '')}</td>
      <td>${esc(e.phone1 || '')}</td>
      <td>${esc(e.phone2 || '')}</td>
      <td>${esc(e.phone3 || '')}</td>
      <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.website || '')}</td>
    </tr>`;
  }).join('');
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}
