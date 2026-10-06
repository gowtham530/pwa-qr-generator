import { 
  getGitHubConfig, 
  saveGitHubConfig, 
  fetchLicensesFromGitHub, 
  pushLicensesToGitHub,
  getLocalLicenses,
  saveLocalLicenses 
} from './github-service.js';

// Default developer passcode
const DEV_PASSCODE = 'ashu2026';
const DEV_AUTH_KEY = 'qr_developer_authenticated_session';

// Check developer authentication
function isDeveloperAuthenticated() {
  return sessionStorage.getItem(DEV_AUTH_KEY) === 'true';
}

function setDeveloperAuthenticated(val) {
  if (val) sessionStorage.setItem(DEV_AUTH_KEY, 'true');
  else sessionStorage.removeItem(DEV_AUTH_KEY);
}

// Generate unique 10-digit numeric serial key (numbers only)
export function generate10DigitSerial() {
  // Generate cryptographically secure random 10-digit number (1000000000 to 9999999999)
  const array = new Uint32Array(2);
  crypto.getRandomValues(array);
  const bigVal = (BigInt(array[0]) << 32n) | BigInt(array[1]);
  const tenDigitNum = 1000000000n + (bigVal % 9000000000n);
  return tenDigitNum.toString();
}

// Format date nicely
function formatDate(isoStr) {
  if (!isoStr) return 'Never';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (e) {
    return isoStr;
  }
}

// Initialize Admin UI
export function initAdminDashboard() {
  const authSection = document.getElementById('dev-auth-section');
  const mainSection = document.getElementById('dev-main-section');
  const passcodeField = document.getElementById('dev-passcode-input');
  const authError = document.getElementById('dev-auth-err');
  const btnLogin = document.getElementById('dev-btn-login');

  if (isDeveloperAuthenticated()) {
    authSection.style.display = 'none';
    mainSection.style.display = 'block';
    loadDashboardData();
  } else {
    authSection.style.display = 'flex';
    mainSection.style.display = 'none';
  }

  btnLogin.addEventListener('click', () => {
    const entered = (passcodeField.value || '').trim();
    if (entered === DEV_PASSCODE) {
      setDeveloperAuthenticated(true);
      authSection.style.display = 'none';
      mainSection.style.display = 'block';
      authError.textContent = '';
      loadDashboardData();
    } else {
      authError.textContent = '❌ Invalid Developer Passcode. Please try again.';
      passcodeField.value = '';
      passcodeField.focus();
    }
  });

  passcodeField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnLogin.click();
  });

  // Settings Modal handlers
  setupSettingsModal();
  // Generator form handlers
  setupGeneratorForm();
}

// Load and Render Users Table
export async function loadDashboardData() {
  const tableBody = document.getElementById('users-table-body');
  const syncStatus = document.getElementById('sync-status-indicator');
  const totalUsersCount = document.getElementById('stat-total-users');
  const totalClicksIssued = document.getElementById('stat-total-clicks');
  const totalClicksUsed = document.getElementById('stat-total-used');

  syncStatus.textContent = '🔄 Loading data from GitHub...';
  syncStatus.style.color = '#38bdf8';

  const res = await fetchLicensesFromGitHub();
  const licenses = res.data || { users: {} };
  const users = licenses.users || {};

  const userKeys = Object.keys(users);
  let totalIssued = 0;
  let totalUsed = 0;

  userKeys.forEach(k => {
    const u = users[k];
    totalIssued += (u.totalClicks || 0);
    totalUsed += (u.usedClicks || 0);
  });

  totalUsersCount.textContent = userKeys.length;
  totalClicksIssued.textContent = totalIssued.toLocaleString();
  totalClicksUsed.textContent = totalUsed.toLocaleString();

  if (res.source === 'github') {
    syncStatus.textContent = '✅ Synced with GitHub';
    syncStatus.style.color = '#10b981';
  } else if (res.source === 'local') {
    syncStatus.textContent = '⚠️ Stored Locally (Configure GitHub in Settings to Sync)';
    syncStatus.style.color = '#f59e0b';
  } else {
    syncStatus.textContent = `ℹ️ ${res.source || 'Loaded'}`;
  }

  // Render Table
  tableBody.innerHTML = '';
  if (userKeys.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 30px; color: #94a3b8;">No users registered yet. Generate the first serial key above!</td></tr>`;
    return;
  }

  // Sort by last active / created
  userKeys.sort((a, b) => {
    const timeA = new Date(users[a].lastActive || users[a].createdAt || 0).getTime();
    const timeB = new Date(users[b].lastActive || users[b].createdAt || 0).getTime();
    return timeB - timeA;
  });

  userKeys.forEach(key => {
    const user = users[key];
    const total = user.totalClicks || 0;
    const used = user.usedClicks || 0;
    const remaining = Math.max(0, total - used);
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

    let badgeClass = 'badge-active';
    let statusText = 'Active';
    if (remaining === 0) {
      badgeClass = 'badge-exhausted';
      statusText = 'Exhausted (0 left)';
    } else if (remaining <= 10) {
      badgeClass = 'badge-low';
      statusText = 'Low Quota';
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <strong style="color:#f8fafc; font-size:15px;">${user.username || key}</strong>
        <div style="font-size:11px; color:#64748b;">Created: ${formatDate(user.createdAt)}</div>
      </td>
      <td>
        <code style="background:rgba(0,0,0,0.4); padding:4px 8px; border-radius:6px; color:#38bdf8; font-weight:600; font-size:13px; letter-spacing:1px;">${user.serial}</code>
        <button class="copy-small-btn" onclick="navigator.clipboard.writeText('${user.serial}'); alert('Copied serial ${user.serial} to clipboard!');" title="Copy Serial">📋</button>
      </td>
      <td>
        <div style="font-weight:600; color:#e2e8f0;">${total} clicks</div>
      </td>
      <td>
        <div style="font-weight:700; color:#f43f5e; font-size:15px;">${used} clicks</div>
        <div class="progress-mini"><div class="progress-mini-fill" style="width: ${pct}%"></div></div>
      </td>
      <td>
        <span class="badge ${badgeClass}">${remaining} clicks left (${statusText})</span>
      </td>
      <td style="font-size:12px; color:#94a3b8;">
        ${formatDate(user.lastActive)}
      </td>
      <td>
        <div class="table-actions">
          <button class="btn-action-small" onclick="window.viewUserHistory('${key}')">📜 History</button>
          <button class="btn-action-danger" onclick="window.deleteUser('${key}')" title="Revoke User">🗑️ Revoke</button>
        </div>
      </td>
    `;
    tableBody.appendChild(tr);
  });
}

// Setup Generator Form
function setupGeneratorForm() {
  const form = document.getElementById('generator-form');
  const userField = document.getElementById('gen-username');
  const clicksField = document.getElementById('gen-clicks');
  const btnSubmit = document.getElementById('gen-btn-submit');
  const resultCard = document.getElementById('gen-result-card');
  const generatedSerialText = document.getElementById('generated-serial-val');
  const generatedUserText = document.getElementById('generated-user-val');
  const generatedClicksText = document.getElementById('generated-clicks-val');
  const copyBtn = document.getElementById('btn-copy-generated');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (userField.value || '').trim();
    const clicks = parseInt(clicksField.value, 10);

    if (!username) {
      alert('Please enter a username.');
      return;
    }
    if (isNaN(clicks) || clicks <= 0) {
      alert('Clicks must be a positive number (e.g. 100).');
      return;
    }

    btnSubmit.disabled = true;
    btnSubmit.textContent = '⏳ Generating & Syncing to GitHub...';

    try {
      const serial = generate10DigitSerial();
      const normKey = username.toLowerCase();

      // Fetch latest licenses
      const res = await fetchLicensesFromGitHub();
      const licenses = res.data || { users: {} };
      if (!licenses.users) licenses.users = {};

      const existingUser = licenses.users[normKey];
      licenses.users[normKey] = {
        username: username,
        serial: serial,
        totalClicks: clicks,
        usedClicks: 0,
        remainingClicks: clicks,
        createdAt: new Date().toISOString(),
        lastActive: null,
        history: existingUser ? existingUser.history || [] : []
      };

      // Push to GitHub
      const pushRes = await pushLicensesToGitHub(licenses, `Generate serial ${serial} for ${username} (${clicks} clicks)`);

      // Update UI
      generatedSerialText.textContent = serial;
      generatedUserText.textContent = username;
      generatedClicksText.textContent = `${clicks} clicks`;
      resultCard.style.display = 'block';

      // Reload table
      await loadDashboardData();

      // Reset form
      userField.value = '';
      clicksField.value = '100';

      if (pushRes && !pushRes.success) {
        alert(`⚠️ User saved locally with ${clicks} clicks!\nSerial: ${serial}\n\nNotice: Could not sync to GitHub remote (${pushRes.error}). Please verify your token in GitHub Settings.`);
      } else {
        alert(`✅ Serial generated for ${username}!\nSerial: ${serial}\nQuota: ${clicks} clicks\n\nSuccessfully synced to GitHub!`);
      }
    } catch (err) {
      alert('Error generating serial: ' + err.message);
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.textContent = '⚡ Generate Serial & Push to GitHub';
    }
  });

  copyBtn.addEventListener('click', () => {
    const serial = generatedSerialText.textContent;
    navigator.clipboard.writeText(serial).then(() => {
      alert(`Copied serial ${serial} to clipboard!`);
    });
  });
}

// Setup GitHub Settings Modal
function setupSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const openBtn = document.getElementById('btn-open-settings');
  const closeBtn = document.getElementById('btn-close-settings');
  const saveBtn = document.getElementById('btn-save-settings');
  const testBtn = document.getElementById('btn-test-github');
  const testMsg = document.getElementById('test-github-msg');

  const ownerInput = document.getElementById('setting-owner');
  const repoInput = document.getElementById('setting-repo');
  const branchInput = document.getElementById('setting-branch');
  const tokenInput = document.getElementById('setting-token');

  openBtn.addEventListener('click', () => {
    const cfg = getGitHubConfig();
    ownerInput.value = cfg.owner || '';
    repoInput.value = cfg.repo || '';
    branchInput.value = cfg.branch || 'main';
    tokenInput.value = cfg.token || '';
    testMsg.textContent = '';
    modal.style.display = 'flex';
  });

  closeBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  saveBtn.addEventListener('click', () => {
    const config = {
      owner: ownerInput.value.trim(),
      repo: repoInput.value.trim(),
      branch: branchInput.value.trim() || 'main',
      token: tokenInput.value.trim(),
      filePath: 'licenses.json'
    };
    saveGitHubConfig(config);
    modal.style.display = 'none';
    loadDashboardData();
  });

  testBtn.addEventListener('click', async () => {
    const owner = ownerInput.value.trim();
    const repo = repoInput.value.trim();
    const token = tokenInput.value.trim();

    if (!owner || !repo || !token) {
      testMsg.textContent = '❌ Please enter GitHub Owner, Repo, and Token first.';
      testMsg.style.color = '#f43f5e';
      return;
    }

    testMsg.textContent = '⏳ Testing connection to GitHub API...';
    testMsg.style.color = '#38bdf8';

    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${token}`
        }
      });

      if (res.ok) {
        testMsg.textContent = `✅ Connection successful! Connected to repository ${owner}/${repo}`;
        testMsg.style.color = '#10b981';
      } else {
        const t = await res.text();
        testMsg.textContent = `❌ GitHub error (${res.status}): ${t}`;
        testMsg.style.color = '#f43f5e';
      }
    } catch (e) {
      testMsg.textContent = `❌ Connection error: ${e.message}`;
      testMsg.style.color = '#f43f5e';
    }
  });
}

// Global actions for table

window.deleteUser = async function(userKey) {
  const confirmDel = confirm(`Are you sure you want to revoke and delete user "${userKey}"?`);
  if (!confirmDel) return;

  const res = await fetchLicensesFromGitHub();
  const licenses = res.data || { users: {} };
  if (licenses.users && licenses.users[userKey]) {
    delete licenses.users[userKey];
    await pushLicensesToGitHub(licenses, `Delete user ${userKey}`);
    alert(`User "${userKey}" removed.`);
    loadDashboardData();
  }
};

window.viewUserHistory = function(userKey) {
  const licenses = getLocalLicenses();
  const u = licenses.users ? licenses.users[userKey] : null;
  if (!u || !u.history || u.history.length === 0) {
    alert(`No QR generation history found yet for user "${userKey}".`);
    return;
  }

  let text = `📜 QR Generation History for ${u.username} (${u.history.length} batches):\n\n`;
  u.history.slice(0, 15).forEach((h, idx) => {
    text += `${idx + 1}. [${h.date} ${h.time}] ${h.startSerial} -> ${h.endSerial} (${h.count} QRs)\n`;
  });
  alert(text);
};

window.recheckGitHubClicks = function() {
  loadDashboardData();
};

window.logoutDeveloper = function() {
  setDeveloperAuthenticated(false);
  location.reload();
};

// Initialize on DOM load if on admin page
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('dev-auth-section')) {
      initAdminDashboard();
    }
  });
}
