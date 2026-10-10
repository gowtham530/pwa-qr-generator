// ============================================================
//  GitHub Synchronization Service
//  Handles syncing serial licenses, click usage, and generation history
// ============================================================

const GITHUB_CONFIG_STORAGE_KEY = 'qr_app_github_config_v1';
const LICENSES_CACHE_KEY = 'qr_app_licenses_cache_v1';

// Default configuration
const DEFAULT_CONFIG = {
  owner: 'gowtham530',
  repo: 'pwa-qr-generator',
  branch: 'main',
  token: '',
  filePath: 'licenses.json'
};

// Built-in sync credentials fallback (empty by default; configured via admin settings)
export function getBuiltinSyncToken() {
  return '';
}

let externalConfigAttempted = false;

export async function ensureConfigLoaded() {
  if (externalConfigAttempted) return getGitHubConfig();
  externalConfigAttempted = true;
  const current = getGitHubConfig();
  try {
    const res = await fetch('./github-config.json', { cache: 'no-store' });
    if (res.ok) {
      const extCfg = await res.json();
      const merged = {
        owner: current.owner || extCfg.owner || 'gowtham530',
        repo: current.repo || extCfg.repo || 'pwa-qr-generator',
        branch: current.branch || extCfg.branch || 'main',
        token: current.token || extCfg.token || getBuiltinSyncToken(),
        filePath: current.filePath || extCfg.filePath || 'licenses.json'
      };
      saveGitHubConfig(merged);
      return merged;
    }
  } catch (e) {
    // Offline or file not accessible
  }
  return current;
}

export function getGitHubConfig() {
  try {
    const raw = localStorage.getItem(GITHUB_CONFIG_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      token: (parsed && parsed.token && parsed.token.trim()) ? parsed.token.trim() : getBuiltinSyncToken()
    };
  } catch (e) {
    return { ...DEFAULT_CONFIG, token: getBuiltinSyncToken() };
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

// Merge remote licenses with local cache to avoid losing usedClicks, while respecting deleted users & renewed users
function mergeLicenses(remoteData) {
  const local = getLocalLicenses();
  const remoteUsers = remoteData?.users || {};
  const localUsers = local?.users || {};

  const finalUsers = {};

  if (Object.keys(remoteUsers).length > 0) {
    // Remote is the authoritative source of truth. Users deleted on remote stay deleted!
    for (const k of Object.keys(remoteUsers)) {
      const uRem = remoteUsers[k];
      const uLoc = localUsers[k];
      const totalClicks = uRem.totalClicks || (uLoc ? uLoc.totalClicks : 100);

      // Only preserve local used clicks if the local license matches the exact active serial
      let usedClicks = uRem.usedClicks || 0;
      if (uLoc && String(uLoc.serial || '').trim() === String(uRem.serial || '').trim()) {
        usedClicks = Math.max(uRem.usedClicks || 0, uLoc.usedClicks || 0);
      }

      finalUsers[k] = {
        ...uRem,
        totalClicks: totalClicks,
        usedClicks: usedClicks,
        remainingClicks: Math.max(0, totalClicks - usedClicks)
      };
    }
  } else {
    // Remote is completely empty (fresh repository or network offline fallback)
    for (const k of Object.keys(localUsers)) {
      finalUsers[k] = { ...localUsers[k] };
    }
  }

  const result = { ...(remoteData || {}), users: finalUsers };
  saveLocalLicenses(result);
  return result;
}

let lastKnownSha = null;

// Fetch licenses from GitHub (multi-device compatible, works with or without token)
export async function fetchLicensesFromGitHub() {
  await ensureConfigLoaded();
  const config = getGitHubConfig();

  if (!config.owner || !config.repo) {
    return { success: true, data: getLocalLicenses(), source: 'local' };
  }

  const token = config.token || getBuiltinSyncToken();

  // 1. Authenticated GitHub Contents API with cache-busting timestamp
  if (token) {
    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}&_t=${Date.now()}`;
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${token}`
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
      console.warn('Authenticated fetch failed, attempting unauthenticated fallback:', err);
    }
  }

  // 2. Unauthenticated GitHub Contents API (bypasses Fastly CDN cache of raw.githubusercontent)
  try {
    const unauthUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}&_t=${Date.now()}`;
    const uRes = await fetch(unauthUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });
    if (uRes.ok) {
      const uJson = await uRes.json();
      if (uJson.sha) lastKnownSha = uJson.sha;
      const content = decodeBase64Utf8(uJson.content);
      const parsedData = JSON.parse(content || '{"users":{}}');
      const merged = mergeLicenses(parsedData);
      return { success: true, data: merged, sha: uJson.sha, source: 'github_api_unauth' };
    }
  } catch (e) {}

  // 3. Fallback to raw.githubusercontent.com
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
  const token = config.token || getBuiltinSyncToken();

  // Always update local cache first
  saveLocalLicenses(licensesData);

  if (!config.owner || !config.repo || !token) {
    return { success: false, error: 'GitHub Token required to sync quota across devices. Saved locally on this device.', source: 'local' };
  }

  // First fetch latest SHA with cache-busting timestamp
  let currentSha = lastKnownSha;
  const getUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}&_t=${Date.now()}`;
  try {
    const getRes = await fetch(getUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`
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
          'Authorization': `Bearer ${token}`
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
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyPayload)
    });

    // Handle 409 Conflict or 422 (SHA out of date) by fetching fresh SHA and retrying once
    if (putRes.status === 409 || putRes.status === 422) {
      try {
        const retryGetRes = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.filePath}?ref=${config.branch}&_t=${Date.now()}`, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${token}`
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
                'Authorization': `Bearer ${token}`,
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
    let localUsedCount = 0;
    try {
      const rawAct = localStorage.getItem('qr_app_active_license_v2');
      if (rawAct) {
        const actObj = JSON.parse(rawAct);
        if ((actObj.username || '').toLowerCase() === normUser) {
          localUsedCount = actObj.usedClicks || 0;
        }
      }
    } catch (e) {}

    u.usedClicks = Math.max((u.usedClicks || 0) + 1, localUsedCount);
    u.remainingClicks = Math.max(0, (u.totalClicks || 100) - u.usedClicks);
    u.lastActive = new Date().toISOString();
    if (!u.history) u.history = [];
    if (batchDetails) {
      u.history.unshift(batchDetails);
      if (u.history.length > 200) u.history.length = 200;
    }
  }

  // Update active license in local storage to match
  try {
    const rawAct = localStorage.getItem('qr_app_active_license_v2');
    if (rawAct) {
      const actObj = JSON.parse(rawAct);
      if ((actObj.username || '').toLowerCase() === normUser && licenses.users[normUser]) {
        actObj.usedClicks = licenses.users[normUser].usedClicks;
        actObj.remainingClicks = licenses.users[normUser].remainingClicks;
        localStorage.setItem('qr_app_active_license_v2', JSON.stringify(actObj));
      }
    }
  } catch (e) {}

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
