// ============================================================
//  GitHub Synchronization Service
//  Handles syncing serial licenses, click usage, and generation history
// ============================================================

const GITHUB_CONFIG_STORAGE_KEY = 'qr_app_github_config_v1';
const LICENSES_CACHE_KEY = 'qr_app_licenses_cache_v1';

// Default configuration fallback
const DEFAULT_CONFIG = {
  owner: 'gowtham530',
  repo: 'pwa-qr-generator',
  branch: 'main',
  token: '',
  filePath: 'licenses.json'
};

let externalConfigAttempted = false;

export async function ensureConfigLoaded() {
  if (externalConfigAttempted) return getGitHubConfig();
  externalConfigAttempted = true;
  try {
    const res = await fetch('./github-config.json', { cache: 'no-store' });
    if (res.ok) {
      const extCfg = await res.json();
      const current = getGitHubConfig();
      const merged = {
        owner: current.owner || extCfg.owner || 'gowtham530',
        repo: current.repo || extCfg.repo || 'pwa-qr-generator',
        branch: current.branch || extCfg.branch || 'main',
        token: current.token || extCfg.token || '',
        filePath: current.filePath || extCfg.filePath || 'licenses.json'
      };
      saveGitHubConfig(merged);
      return merged;
    }
  } catch (e) {
    // Offline or file not accessible
  }
  return getGitHubConfig();
}

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

// Merge remote licenses with local cache to avoid ever wiping out users
function mergeLicenses(remoteData) {
  const local = getLocalLicenses();
  const remoteUsers = remoteData?.users || {};
  const localUsers = local?.users || {};

  // Combine both sets of users
  const mergedUsers = { ...localUsers, ...remoteUsers };

  for (const k of Object.keys(mergedUsers)) {
    if (localUsers[k] && remoteUsers[k]) {
      const uLoc = localUsers[k];
      const uRem = remoteUsers[k];
      mergedUsers[k] = {
        ...uLoc,
        ...uRem,
        totalClicks: uRem.totalClicks || uLoc.totalClicks || 100,
        usedClicks: Math.max(uRem.usedClicks || 0, uLoc.usedClicks || 0),
        remainingClicks: Math.max(0, (uRem.totalClicks || uLoc.totalClicks || 100) - Math.max(uRem.usedClicks || 0, uLoc.usedClicks || 0)),
      };
    }
  }

  const result = { ...(remoteData || {}), users: mergedUsers };
  saveLocalLicenses(result);
  return result;
}

let lastKnownSha = null;

// Fetch licenses from GitHub (multi-device compatible, works with or without token)
export async function fetchLicensesFromGitHub() {
  await ensureConfigLoaded();
  const config = getGitHubConfig();

  if (!config.owner || !config.repo) {
    // Neither owner nor repo configured, return local cache
    return { success: true, data: getLocalLicenses(), source: 'local' };
  }

  // 1. If Token is present, use authenticated GitHub Contents API
  if (config.token) {
    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}`;
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${config.token}`
        }
      });

      if (res.status === 404) {
        return { success: true, data: getLocalLicenses(), sha: null, source: 'github_new' };
      }

      if (res.ok) {
        const json = await res.json();
        if (json.sha) lastKnownSha = json.sha;
        const content = decodeBase64Utf8(json.content);
        const parsedData = JSON.parse(content || '{"users":{}}');
        const merged = mergeLicenses(parsedData);
        return { success: true, data: merged, sha: json.sha, source: 'github' };
      }
    } catch (err) {
      console.warn('Authenticated fetch failed, attempting raw fetch fallback:', err);
    }
  }

  // 2. Multi-device Public Fallback: Fetch directly from raw.githubusercontent.com
  const rawUrl = `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${config.filePath}?t=${Date.now()}`;
  try {
    const res = await fetch(rawUrl, { cache: 'no-store' });
    if (res.ok) {
      const parsedData = await res.json();
      const merged = mergeLicenses(parsedData);
      return { success: true, data: merged, source: 'github_public' };
    }
  } catch (e) {
    console.warn('Raw GitHub fetch failed, using local cache:', e);
  }

  return { success: true, data: getLocalLicenses(), source: 'local_fallback' };
}

// Push updated licenses to GitHub
export async function pushLicensesToGitHub(licensesData, commitMessage = 'Update serial licenses and click counts') {
  await ensureConfigLoaded();
  const config = getGitHubConfig();
  // Always update local cache first
  saveLocalLicenses(licensesData);

  if (!config.owner || !config.repo || !config.token) {
    return { success: false, error: 'GitHub Token required to sync quota across devices. Saved locally on this device.', source: 'local' };
  }

  // First fetch latest SHA
  let currentSha = lastKnownSha;
  const getUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}`;
  try {
    const getRes = await fetch(getUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${config.token}`
      }
    });
    if (getRes.ok) {
      const getJson = await getRes.json();
      if (getJson.sha) {
        currentSha = getJson.sha;
        lastKnownSha = getJson.sha;
      }
    }
  } catch (e) {
    console.warn('Could not fetch existing SHA:', e);
  }

  // Fallback SHA retrieval without query parameter if needed
  if (!currentSha) {
    try {
      const fallbackUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}`;
      const fRes = await fetch(fallbackUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${config.token}`
        }
      });
      if (fRes.ok) {
        const fJson = await fRes.json();
        if (fJson.sha) {
          currentSha = fJson.sha;
          lastKnownSha = fJson.sha;
        }
      }
    } catch (e) {}
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
    let putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyPayload)
    });

    // Handle 409 Conflict (SHA out of date) by fetching fresh SHA and retrying once
    if (putRes.status === 409 || putRes.status === 422) {
      try {
        const retryGetRes = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}`, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${config.token}`
          }
        });
        if (retryGetRes.ok) {
          const rJson = await retryGetRes.json();
          if (rJson.sha) {
            bodyPayload.sha = rJson.sha;
            lastKnownSha = rJson.sha;
            putRes = await fetch(putUrl, {
              method: 'PUT',
              headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `Bearer ${config.token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(bodyPayload)
            });
          }
        }
      } catch (retryErr) {}
    }

    if (!putRes.ok) {
      const errText = await putRes.text();
      return { success: false, error: `GitHub push failed (${putRes.status}): ${errText}` };
    }

    const putJson = await putRes.json();
    if (putJson.content && putJson.content.sha) {
      lastKnownSha = putJson.content.sha;
    }
    return { success: true, sha: lastKnownSha, source: 'github' };
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
      if (u.history.length > 200) u.history.length = 200;
    }
  }

  saveLocalLicenses(licenses);
  const pushRes = await pushLicensesToGitHub(licenses, `Record 1 click for ${username} (Used: ${licenses.users[normUser].usedClicks})`);
  if (pushRes.success) {
    console.log('✅ Successfully synced click count to GitHub');
  } else {
    console.warn('⚠️ Multi-device sync notice:', pushRes.error);
  }
  return pushRes;
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
