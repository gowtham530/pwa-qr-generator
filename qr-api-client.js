// ============================================================
// Secure QR Client API
// Communicates with Netlify Serverless Backend
// - No secret keys or encryption algorithms stored on device
// - Works in PWA web browser and Capacitor Android APK
// ============================================================

const PRODUCTION_API_URL = 'https://genqr580.netlify.app/api/qr-service';

// Detect whether we are in a mobile native wrapper (Capacitor), GitHub Pages, or Netlify
function getApiEndpoint() {
  if (typeof window !== 'undefined') {
    // When running directly on Netlify, use relative /api/qr-service
    if (window.location.hostname.endsWith('netlify.app')) {
      return '/api/qr-service';
    }
  }
  // When running on GitHub Pages (gowtham530.github.io) or in Capacitor Android APK, use Netlify cloud API
  return PRODUCTION_API_URL;
}

/**
 * Encrypt a batch of serials and record usage click on server
 * @param {string} username - User license name
 * @param {string} serial - License serial key
 * @param {string[]} serials - Array of serial numbers to encrypt
 * @param {object} batchInfo - Generation batch details (uan, count, startSerial, etc.)
 */
export async function requestBatchEncryption(username, serial, serials, batchInfo = null) {
  const endpoint = getApiEndpoint();

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'encrypt',
        username,
        serial,
        serials,
        batchInfo
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Server returned error (${res.status})`);
    }

    return data;
  } catch (err) {
    if (!navigator.onLine) {
      throw new Error('❌ No internet connection. An active internet connection is required to verify your license and generate QRs.');
    }
    throw err;
  }
}

/**
 * Encrypt a single serial for preview
 */
export async function requestSingleEncryption(username, serial, serialToEncrypt) {
  const endpoint = getApiEndpoint();

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'preview',
        username,
        serial,
        serialToEncrypt: serialToEncrypt
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to preview QR code.');
    }

    return data.encrypted;
  } catch (err) {
    if (!navigator.onLine) {
      throw new Error('❌ Internet connection required for preview.');
    }
    throw err;
  }
}

/**
 * Validate and activate license key on the secure server
 */
export async function activateLicenseRemote(username, serial) {
  const endpoint = getApiEndpoint();

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'activate',
        username,
        serial
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || 'Activation failed.' };
    }

    return { success: true, license: data.license };
  } catch (err) {
    return {
      success: false,
      error: !navigator.onLine 
        ? '❌ No internet connection. Please connect to the internet to activate your license.'
        : `Server communication error: ${err.message}`
    };
  }
}

/**
 * Sync active quota from server
 */
export async function syncQuotaRemote(username, serial) {
  const endpoint = getApiEndpoint();

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sync',
        username,
        serial
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || 'Sync failed.' };
    }

    return {
      success: true,
      totalClicks: data.totalClicks,
      usedClicks: data.usedClicks,
      remainingClicks: data.remainingClicks
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
