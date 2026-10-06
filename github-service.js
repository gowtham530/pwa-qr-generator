// ============================================================
//  GitHub Synchronization Service
//  Handles syncing serial licenses, click usage, and generation history
// ============================================================

const GITHUB_CONFIG_STORAGE_KEY = 'qr_app_github_config_v1';
const LICENSES_CACHE_KEY = 'qr_app_licenses_cache_v1';

// Default configuration fallback
const DEFAULT_CONFIG = {
  owner: '',
  repo: '',
  branch: 'main',
  token: '',
  filePath: 'licenses.json'
};

export function getGitHubConfig() {
  try {
    const raw = localStorage.getItem(GITHUB_CONFIG_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveGitHubConfig(config) {
  localStorage.setItem(GITHUB_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

export function getLocalLicenses() {
  try {
    const raw = localStorage.getItem(LICENSES_CACHE_KEY);
    if (!raw) return { users: {} };
    return JSON.parse(raw);
  } catch (e) {
    return { users: {} };
  }
}

export function saveLocalLicenses(data) {
  localStorage.setItem(LICENSES_CACHE_KEY, JSON.stringify(data));
}

// Fetch licenses from GitHub (or local cache if not configured / offline)
export async function fetchLicensesFromGitHub() {
  const config = getGitHubConfig();
  if (!config.owner || !config.repo || !config.token) {
    // If GitHub credentials are not configured, return local cache
    return { success: true, data: getLocalLicenses(), source: 'local' };
  }

  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${config.token}`,
        'Cache-Control': 'no-cache'
      }
    });

    if (res.status === 404) {
      // File doesn't exist yet on GitHub, return empty licenses and save SHA as null
      return { success: true, data: { users: {} }, sha: null, source: 'github_new' };
    }

    if (!res.ok) {
      const errText = await res.text();
      return { success: false, error: `GitHub API error (${res.status}): ${errText}`, data: getLocalLicenses(), source: 'local_fallback' };
    }

    const json = await res.json();
    const content = decodeBase64Utf8(json.content);
    const parsedData = JSON.parse(content || '{"users":{}}');
    
    // Cache locally
    saveLocalLicenses(parsedData);
    return { success: true, data: parsedData, sha: json.sha, source: 'github' };
  } catch (err) {
    console.warn('Network error fetching from GitHub, falling back to local cache:', err);
    return { success: false, error: err.message, data: getLocalLicenses(), source: 'local_fallback' };
  }
}

// Push updated licenses to GitHub
export async function pushLicensesToGitHub(licensesData, commitMessage = 'Update serial licenses and click counts') {
  const config = getGitHubConfig();
  // Always update local cache first
  saveLocalLicenses(licensesData);

  if (!config.owner || !config.repo || !config.token) {
    return { success: true, message: 'Saved locally (GitHub sync not configured)', source: 'local' };
  }

  // First fetch latest SHA
  let currentSha = null;
  const getUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}`;
  try {
    const getRes = await fetch(getUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${config.token}`,
        'Cache-Control': 'no-cache'
      }
    });
    if (getRes.ok) {
      const getJson = await getRes.json();
      currentSha = getJson.sha;
    }
  } catch (e) {
    console.warn('Could not fetch existing SHA:', e);
  }

  const contentStr = JSON.stringify(licensesData, null, 2);
  const base64Content = encodeBase64Utf8(contentStr);

  const putUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}`;
  const bodyPayload = {
    message: commitMessage,
    content: base64Content,
    branch: config.branch
  };
  if (currentSha) {
    bodyPayload.sha = currentSha;
  }

  try {
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyPayload)
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return { success: false, error: `GitHub push failed (${putRes.status}): ${errText}` };
    }

    const putJson = await putRes.json();
    return { success: true, sha: putJson.content ? putJson.content.sha : null, source: 'github' };
  } catch (err) {
    return { success: false, error: `GitHub network error: ${err.message}` };
  }
}

// Helper: Record user click usage in GitHub
export async function recordUserClick(username, batchDetails = null) {
  const normUser = (username || '').trim().toLowerCase();
  if (!normUser) return;

  const licRes = await fetchLicensesFromGitHub();
  const licenses = licRes.data || { users: {} };
  if (!licenses.users) licenses.users = {};

  if (!licenses.users[normUser]) {
    // If not found, create placeholder
    licenses.users[normUser] = {
      username: username.trim(),
      totalClicks: 100,
      usedClicks: 1,
      remainingClicks: 99,
      history: []
    };
  } else {
    const u = licenses.users[normUser];
    u.usedClicks = (u.usedClicks || 0) + 1;
    u.remainingClicks = Math.max(0, (u.totalClicks || 100) - u.usedClicks);
    u.lastActive = new Date().toISOString();
    if (!u.history) u.history = [];
    if (batchDetails) {
      u.history.unshift(batchDetails);
      // Limit history to 200 items
      if (u.history.length > 200) u.history.length = 200;
    }
  }

  saveLocalLicenses(licenses);
  // Asynchronously sync to GitHub
  pushLicensesToGitHub(licenses, `Record 1 click for ${username} (Used: ${licenses.users[normUser].usedClicks})`)
    .then(r => {
      if (r.success) console.log('Successfully synced click count to GitHub');
      else console.warn('Could not sync click to GitHub:', r.error);
    })
    .catch(e => console.warn('Sync error:', e));
}

// UTF-8 friendly base64 encoding & decoding
function encodeBase64Utf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function decodeBase64Utf8(base64) {
  try {
    return decodeURIComponent(escape(atob(base64.replace(/\s/g, ''))));
  } catch (e) {
    return atob(base64.replace(/\s/g, ''));
  }
}
