const crypto = require('crypto');

// ============================================================
// Secure Serverless QR Service (Netlify Function)
// - Keeps AES Keys & GitHub Tokens on the server
// - Verifies user serial keys before encrypting
// - Deducts usage and tracks generation history
// ============================================================

// Secret Keys (Loaded strictly from Netlify Environment Variables)
const QR_KEY_HEX = process.env.QR_KEY_HEX;
const QR_IV_HEX  = process.env.QR_IV_HEX;

// GitHub Sync Config (Private token kept on server only)
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'gowtham530';
const GITHUB_REPO = process.env.GITHUB_REPO || 'pwa-qr-generator';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH || 'licenses.json';

// Resolves GitHub token strictly from environment variable
function getGitHubToken() {
  return (process.env.GITHUB_TOKEN || '').trim();
}

// Helper: Encrypt plaintext using AES-256-GCM
function encryptAESGCM(plaintext) {
  const key = Buffer.from(QR_KEY_HEX.replace(/[^0-9a-fA-F]/g, ''), 'hex');
  const iv = Buffer.from(QR_IV_HEX.replace(/[^0-9a-fA-F]/g, ''), 'hex');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return enc + tag;
}

// Helper: Fetch licenses.json from GitHub
async function getLicensesFromGitHub() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}?ref=${GITHUB_BRANCH}&_t=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${getGitHubToken()}`,
      'User-Agent': 'Netlify-QR-Service'
    }
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  return {
    sha: json.sha,
    data: JSON.parse(content)
  };
}

// Helper: Save updated licenses.json back to GitHub
async function saveLicensesToGitHub(data, sha, message) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
  
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${getGitHubToken()}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Netlify-QR-Service'
    },
    body: JSON.stringify({
      message: message || 'Auto-record QR generation click & history',
      content: content,
      sha: sha,
      branch: GITHUB_BRANCH
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn('Failed to save to GitHub:', errText);
    return false;
  }
  return true;
}

// Main Handler
exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    let body = {};
    if (event.body) {
      body = JSON.parse(event.body);
    }

    const action = body.action || (event.queryStringParameters && event.queryStringParameters.action) || 'ping';

    // 1. Health check
    if (action === 'ping') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'QR Secure Service is active.' })
      };
    }

    // 2. Validate / Activate License
    if (action === 'activate') {
      const username = (body.username || '').trim().toLowerCase();
      const serial = (body.serial || '').trim();

      if (!username || !serial) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, error: 'Username and Serial number are required.' })
        };
      }

      const { data } = await getLicensesFromGitHub();
      const users = data.users || {};
      
      let matched = users[username];
      if (!matched) {
        const foundKey = Object.keys(users).find(k => String(users[k].serial || '').trim() === serial);
        if (foundKey) matched = users[foundKey];
      }

      if (matched && String(matched.serial || '').trim() === serial) {
        const total = Number(matched.totalClicks) || 100;
        const used = Number(matched.usedClicks) || 0;
        const rem = Math.max(0, total - used);

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            license: {
              username: matched.username || username,
              serial: serial,
              totalClicks: total,
              usedClicks: used,
              remainingClicks: rem
            }
          })
        };
      }

      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ success: false, error: 'Invalid Username or Serial Key.' })
      };
    }

    // 3. Sync Quota
    if (action === 'sync') {
      const username = (body.username || '').trim().toLowerCase();
      const serial = (body.serial || '').trim();

      const { data } = await getLicensesFromGitHub();
      const users = data.users || {};
      let matched = users[username];
      if (!matched && serial) {
        const foundKey = Object.keys(users).find(k => String(users[k].serial || '').trim() === serial);
        if (foundKey) matched = users[foundKey];
      }

      if (matched) {
        const total = Number(matched.totalClicks) || 100;
        const used = Number(matched.usedClicks) || 0;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            totalClicks: total,
            usedClicks: used,
            remainingClicks: Math.max(0, total - used)
          })
        };
      }

      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ success: false, error: 'User license not found.' })
      };
    }

    // 4. Free Preview (Encrypts 1 code for preview without deducting quota)
    if (action === 'preview') {
      const username = (body.username || '').trim().toLowerCase();
      const serial = (body.serial || '').trim();
      const serialToEncrypt = body.serialToEncrypt || (body.serials && body.serials[0]);

      if (!serialToEncrypt) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, error: 'No serial provided for preview.' })
        };
      }

      const { data } = await getLicensesFromGitHub();
      const users = data.users || {};
      let matched = users[username];
      if (!matched && serial) {
        const foundKey = Object.keys(users).find(k => String(users[k].serial || '').trim() === serial);
        if (foundKey) matched = users[foundKey];
      }

      if (!matched || String(matched.serial || '').trim() !== serial) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ success: false, error: 'Authentication failed. Invalid serial key.' })
        };
      }

      const encrypted = encryptAESGCM(serialToEncrypt);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, encrypted })
      };
    }

    // 5. Encrypt QR Codes & Deduct Click Quota
    if (action === 'encrypt') {
      const username = (body.username || '').trim().toLowerCase();
      const serial = (body.serial || '').trim();
      const serials = body.serials || (body.serialToEncrypt ? [body.serialToEncrypt] : []);
      const batchInfo = body.batchInfo || null;

      if (!serials || serials.length === 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, error: 'No serial numbers provided to encrypt.' })
        };
      }

      // Check license on server
      const { data, sha } = await getLicensesFromGitHub();
      const users = data.users || {};
      let userKey = username;
      let matched = users[userKey];

      if (!matched && serial) {
        const foundKey = Object.keys(users).find(k => String(users[k].serial || '').trim() === serial);
        if (foundKey) {
          userKey = foundKey;
          matched = users[foundKey];
        }
      }

      if (!matched || String(matched.serial || '').trim() !== serial) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ success: false, error: 'Authentication failed. Invalid serial key.' })
        };
      }

      const total = Number(matched.totalClicks) || 100;
      let used = Number(matched.usedClicks) || 0;
      let rem = Math.max(0, total - used);

      if (rem <= 0) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ success: false, error: 'Click quota exhausted! Please contact developer for renewal.' })
        };
      }

      // Deduct 1 click for this generation operation
      used += 1;
      rem = Math.max(0, total - used);
      matched.usedClicks = used;
      matched.remainingClicks = rem;
      matched.lastActive = new Date().toISOString();

      if (batchInfo) {
        if (!Array.isArray(matched.history)) matched.history = [];
        matched.history.unshift({
          date: batchInfo.date || new Date().toISOString().slice(0, 10),
          time: batchInfo.time || new Date().toLocaleTimeString(),
          uan: batchInfo.uan || '',
          startSerial: batchInfo.startSerial || '',
          endSerial: batchInfo.endSerial || '',
          count: batchInfo.count || serials.length
        });
        if (matched.history.length > 50) matched.history = matched.history.slice(0, 50);
      }

      data.updatedAt = new Date().toISOString();

      // Save asynchronously in background so client gets fast response
      saveLicensesToGitHub(data, sha, `Record click for ${username} (remaining: ${rem})`).catch(e => {
        console.error('Async GitHub save error:', e);
      });

      // Encrypt all serials with the server's private AES key
      const encrypted = serials.map(s => encryptAESGCM(s));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          encrypted: encrypted,
          usedClicks: used,
          remainingClicks: rem,
          totalClicks: total
        })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, error: `Unknown action: ${action}` })
    };

  } catch (err) {
    console.error('Serverless QR Service Exception:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message || 'Internal server error.' })
    };
  }
};
