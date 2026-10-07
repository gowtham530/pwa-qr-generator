import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { 
  fetchLicensesFromGitHub, 
  recordUserClick, 
  getLocalLicenses, 
  saveLocalLicenses 
} from './github-service.js';

// ============================================================
//  1. AES-256-GCM Encryption Module (For QR Code Contents)
// ============================================================
const QR_KEY_HEX = 'fdeffaeff7efbfeffd72fefceffcef2fefefcfefefefefeffa2eeff7feefef75';
const QR_IV_HEX  = 'ffeffaefefefefc5a7efef9c';

// Storage keys
const LICENSE_STORAGE_KEY = 'qr_app_active_license_v2';
const HISTORY_STORAGE_KEY = 'qr_app_daywise_history_v1';
const PERM_REGISTRY_KEY   = 'qr_app_permanent_registry_v1';

// -----------------------------------------------------------
// Helpers: Hex <--> Bytes
// -----------------------------------------------------------
function hexToBytes(hex) {
  const cleanHex = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// -----------------------------------------------------------
// QR Code Encryption (Pure JS AES-256-GCM)
// -----------------------------------------------------------
async function encryptAESGCM(plaintext) {
  const key = hexToBytes(QR_KEY_HEX);
  const iv  = hexToBytes(QR_IV_HEX);
  const pt = new TextEncoder().encode(plaintext);

  try {
    const cipher = gcm(key, iv);
    const encrypted = cipher.encrypt(pt);
    return bytesToHex(encrypted);
  } catch (nobleErr) {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        cryptoKey,
        pt
      );
      return bytesToHex(new Uint8Array(encrypted));
    }
    throw nobleErr;
  }
}

// ============================================================
//  2. 14-Character Serial Number Validation (AP25R...)
// ============================================================
export function validate14CharSerial(serialVal, fieldPrefix) {
  const s = (serialVal || '').trim().toUpperCase();
  const countEl = document.getElementById(`${fieldPrefix}-char-count`);
  const errEl = document.getElementById(`${fieldPrefix}-serial-err`);
  const inputEl = document.getElementById(`${fieldPrefix}-pdf`);

  const len = s.length;
  if (countEl) {
    countEl.textContent = `${len}/14`;
    if (len === 14 && s.startsWith('AP25R')) {
      countEl.className = 'char-badge valid';
    } else {
      countEl.className = 'char-badge invalid';
    }
  }

  let error = '';
  if (!s) {
    error = 'Serial number is required.';
  } else if (!s.startsWith('AP25R')) {
    error = 'Serial must start with AP25R';
  } else if (len < 14) {
    error = `Too short: ${len}/14 characters (need ${14 - len} more)`;
  } else if (len > 14) {
    error = `Too long: ${len}/14 characters (maximum 14)`;
  }

  if (errEl) {
    errEl.textContent = error;
  }
  if (inputEl) {
    if (error) {
      inputEl.classList.add('input-invalid');
      inputEl.classList.remove('input-valid');
    } else {
      inputEl.classList.remove('input-invalid');
      inputEl.classList.add('input-valid');
    }
  }

  return { isValid: !error, error, cleanValue: s };
}

export function validateAllSerials() {
  const startInput = document.getElementById('start-pdf');
  const endInput = document.getElementById('end-pdf');
  const mainErr = document.getElementById('err-pdf');

  const startRes = validate14CharSerial(startInput.value, 'start');
  const endRes = validate14CharSerial(endInput.value, 'end');

  if (!startRes.isValid) {
    if (mainErr) mainErr.textContent = `❌ Start Serial Error: ${startRes.error}`;
    return false;
  }
  if (!endRes.isValid) {
    if (mainErr) mainErr.textContent = `❌ End Serial Error: ${endRes.error}`;
    return false;
  }

  if (mainErr) mainErr.textContent = '';
  return true;
}

// Auto-fill end serial when start serial is entered
export function autoFillEndSerial() {
  const startInput = document.getElementById('start-pdf');
  const endInput = document.getElementById('end-pdf');
  const countInput = document.getElementById('count-pdf');
  if (!startInput || !endInput) return;

  const val = startInput.value.trim().toUpperCase();
  validate14CharSerial(val, 'start');
  if (!val || !val.startsWith('AP25R')) return;

  // Pattern: AP25R followed by digits
  const match = val.match(/^AP25R(\d+)$/);
  if (match) {
    const numPart = match[1];
    const digits = numPart.length;
    try {
      const startNum = BigInt(numPart);
      const endNum = startNum + 579n;
      const endNumStr = endNum.toString().padStart(digits, '0');
      const calculatedEnd = 'AP25R' + endNumStr;
      if (calculatedEnd.length === 14) {
        endInput.value = calculatedEnd;
        validate14CharSerial(calculatedEnd, 'end');
      }
      if (countInput) {
        countInput.max = "580";
        if (!countInput.value || parseInt(countInput.value, 10) > 580) {
          countInput.value = "580";
        }
      }
    } catch (e) {
      console.warn('Could not compute end serial', e);
    }
  }
}

// Parse Serial for generation
function parseSerial(s) {
  s = (s || '').trim().toUpperCase();
  const m = s.match(/^(.*?)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], num: m[2], digits: m[2].length };
}

function getSelectedSerials() {
  const mainErr = document.getElementById('err-pdf');
  mainErr.textContent = '';
  document.getElementById('success-pdf').style.display = 'none';

  if (!validateAllSerials()) {
    return null;
  }

  const sv = document.getElementById('start-pdf').value.trim().toUpperCase();
  const ev = document.getElementById('end-pdf').value.trim().toUpperCase();
  const count = parseInt(document.getElementById('count-pdf').value, 10);

  if (isNaN(count) || count < 1) {
    mainErr.textContent = '❌ Please enter a valid number of QR codes to generate.';
    return null;
  }

  const sp = parseSerial(sv);
  const ep = parseSerial(ev);

  if (!sp || !ep) {
    mainErr.textContent = '❌ Invalid serial format. Must end with numbers.';
    return null;
  }
  if (sp.prefix !== ep.prefix) {
    mainErr.textContent = '❌ Prefix mismatch between Start and End serial numbers.';
    return null;
  }

  const startN = BigInt(sp.num);
  const endN = BigInt(ep.num);
  if (endN < startN) {
    mainErr.textContent = '❌ End serial number must be greater than or equal to start serial.';
    return null;
  }

  const rangeSize = Number(endN - startN) + 1;
  if (count > rangeSize) {
    mainErr.textContent = `❌ Cannot select ${count} codes from a range of ${rangeSize}.`;
    return null;
  }

  const allNums = [];
  for (let n = startN; n <= endN; n++) {
    allNums.push(sp.prefix + n.toString().padStart(sp.digits, '0'));
  }

  const selected = new Set();
  const serials = [];
  while (serials.length < count) {
    const idx = Math.floor(Math.random() * allNums.length);
    if (!selected.has(idx)) {
      selected.add(idx);
      serials.push(allNums[idx]);
    }
  }

  return serials;
}

// ============================================================
//  3. License & Click Quota Management
// ============================================================
function getActiveLicense() {
  try {
    const raw = localStorage.getItem(LICENSE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveActiveLicense(licenseData) {
  localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(licenseData));
  updateLicenseUI();
}

export function updateLicenseUI() {
  const license = getActiveLicense();
  const userText = document.getElementById('active-username-text');
  const quotaText = document.getElementById('active-quota-text');
  const quotaPill = document.getElementById('quota-pill');
  const exhaustedBanner = document.getElementById('exhausted-banner');

  if (!license) {
    if (userText) userText.textContent = 'Unactivated';
    if (quotaText) quotaText.textContent = '0 / 0';
    if (quotaPill) quotaPill.className = 'quota-pill exhausted';
    if (exhaustedBanner) exhaustedBanner.style.display = 'none';
    return;
  }

  if (userText) userText.textContent = license.username;
  const rem = license.remainingClicks ?? (license.totalClicks - (license.usedClicks || 0));
  const total = license.totalClicks || 100;
  if (quotaText) quotaText.textContent = `${rem} / ${total} clicks left`;

  if (quotaPill) {
    quotaPill.classList.remove('low', 'exhausted');
    if (rem <= 0) {
      quotaPill.classList.add('exhausted');
      if (exhaustedBanner) exhaustedBanner.style.display = 'block';
    } else if (rem <= Math.max(5, Math.floor(total * 0.2))) {
      quotaPill.classList.add('low');
      if (exhaustedBanner) exhaustedBanner.style.display = 'none';
    } else {
      if (exhaustedBanner) exhaustedBanner.style.display = 'none';
    }
  }
}

// Automatically sync latest quota from GitHub for active user
export async function syncLatestQuotaFromGitHub(showToast = false) {
  const currentLicense = getActiveLicense();
  if (!currentLicense) return;

  try {
    const licRes = await fetchLicensesFromGitHub();
    const licenses = licRes.data || { users: {} };
    const users = licenses.users || {};

    let matchedUser = users[currentLicense.username?.toLowerCase()];
    if (!matchedUser && currentLicense.serialNumber) {
      const foundKey = Object.keys(users).find(k => String(users[k].serial || '').trim() === String(currentLicense.serialNumber).trim());
      if (foundKey) matchedUser = users[foundKey];
    }

    if (matchedUser) {
      const remoteTotal = Number(matchedUser.totalClicks) || 100;
      const remoteUsed = Number(matchedUser.usedClicks) || 0;
      const localUsed = Number(currentLicense.usedClicks) || 0;
      const isSameSerial = String(matchedUser.serial || '').trim() === String(currentLicense.serialNumber || '').trim();

      // If user was renewed with a new serial on remote, discard old local click count
      let effectiveUsed = remoteUsed;
      if (isSameSerial) {
        effectiveUsed = Math.max(remoteUsed, localUsed);
      }

      currentLicense.totalClicks = remoteTotal;
      currentLicense.usedClicks = effectiveUsed;
      currentLicense.remainingClicks = Math.max(0, remoteTotal - effectiveUsed);
      if (matchedUser.serial) currentLicense.serialNumber = String(matchedUser.serial);
      saveActiveLicense(currentLicense);
      updateLicenseUI();

      if (isSameSerial && localUsed > remoteUsed) {
        recordUserClick(currentLicense.username);
      }
      if (showToast) {
        alert(`✅ Quota refreshed!\nTotal: ${currentLicense.totalClicks} clicks\nRemaining: ${currentLicense.remainingClicks} clicks left`);
      }
    } else if (showToast) {
      alert(`Current quota: ${currentLicense.remainingClicks} / ${currentLicense.totalClicks} clicks`);
    }
  } catch (err) {
    console.warn('Could not sync latest quota from GitHub:', err);
    if (showToast) {
      alert(`⚠️ Could not sync with server: ${err.message}`);
    }
  }
}

// User Registration with Developer Serial Key
export async function activateLicense(username, serialKey) {
  const cleanUser = (username || '').trim();
  const cleanKey = (serialKey || '').trim().toUpperCase();

  if (!cleanUser) {
    return { success: false, error: 'Please enter your username.' };
  }
  if (!cleanKey) {
    return { success: false, error: 'Please enter the Serial Number provided by the developer.' };
  }

  // First verify against GitHub / Local Licenses database
  try {
    const licRes = await fetchLicensesFromGitHub();
    const licenses = licRes.data || { users: {} };
    const users = licenses.users || {};
    const normUser = cleanUser.toLowerCase();

    let matchedUser = users[normUser];
    if (!matchedUser) {
      const foundKey = Object.keys(users).find(k => String(users[k].serial || '').trim() === cleanKey);
      if (foundKey) matchedUser = users[foundKey];
    }

    if (matchedUser && String(matchedUser.serial || '').trim() === cleanKey) {
      const allowedClicks = Number(matchedUser.totalClicks) || 100;
      const usedClicks = Number(matchedUser.usedClicks) || 0;
      const remainingClicks = Math.max(0, allowedClicks - usedClicks);

      const licenseRecord = {
        username: matchedUser.username || cleanUser,
        totalClicks: allowedClicks,
        usedClicks: usedClicks,
        remainingClicks: remainingClicks,
        serialNumber: cleanKey,
        activatedAt: Date.now()
      };
      saveActiveLicense(licenseRecord);
      return { success: true, license: licenseRecord };
    }
  } catch (err) {
    console.warn('Error checking GitHub licenses during activation:', err);
  }

  // Also check local licenses directly
  const localLics = getLocalLicenses();
  const localUsers = localLics.users || {};
  let localMatch = localUsers[cleanUser.toLowerCase()];
  if (!localMatch) {
    const foundKey = Object.keys(localUsers).find(k => String(localUsers[k].serial || '').trim() === cleanKey);
    if (foundKey) localMatch = localUsers[foundKey];
  }

  if (localMatch && String(localMatch.serial || '').trim() === cleanKey) {
    const allowedClicks = Number(localMatch.totalClicks) || 100;
    const usedClicks = Number(localMatch.usedClicks) || 0;
    const remainingClicks = Math.max(0, allowedClicks - usedClicks);

    const licenseRecord = {
      username: localMatch.username || cleanUser,
      totalClicks: allowedClicks,
      usedClicks: usedClicks,
      remainingClicks: remainingClicks,
      serialNumber: cleanKey,
      activatedAt: Date.now()
    };
    saveActiveLicense(licenseRecord);
    return { success: true, license: licenseRecord };
  }

  // If serial is 10-digit numeric key, allow standard 100 clicks activation if valid
  if (/^\d{10}$/.test(cleanKey)) {
    const licenseRecord = {
      username: cleanUser,
      totalClicks: 100,
      usedClicks: 0,
      remainingClicks: 100,
      serialNumber: cleanKey,
      activatedAt: Date.now()
    };
    saveActiveLicense(licenseRecord);
    return { success: true, license: licenseRecord };
  }

  return { success: false, error: '❌ Invalid 10-digit serial number or Username mismatch. Please check with Developer.' };
}

// Click Quota Deductor: Consumes 1 Click per PDF generation tap
function consumeClickQuota() {
  const license = getActiveLicense();

  if (!license) {
    openLicenseModal(false, 'Activation Required', 'Please register with the Username and Serial Key provided by the developer.');
    return false;
  }

  const rem = license.remainingClicks ?? (license.totalClicks - (license.usedClicks || 0));
  if (rem <= 0) {
    updateLicenseUI();
    openLicenseModal(true, 'Click Quota Exhausted (0 Left)', `You have used all ${license.totalClicks} clicks allocated by the developer. Please contact the developer for a new serial key.`);
    return false;
  }

  // Deduct 1 click
  license.usedClicks = (license.usedClicks || 0) + 1;
  license.remainingClicks = Math.max(0, license.totalClicks - license.usedClicks);
  saveActiveLicense(license);
  return true;
}

// Modal Handlers
export function openLicenseModal(allowClose = true, title = null, desc = null) {
  const modal = document.getElementById('license-modal');
  const closeX = document.getElementById('modal-close-x');
  const errDiv = document.getElementById('modal-err-msg');
  const titleEl = document.getElementById('modal-title-text');
  const descEl = document.getElementById('modal-desc-text');
  const userInput = document.getElementById('input-license-user');
  const keyInput = document.getElementById('input-license-key');

  if (errDiv) errDiv.textContent = '';
  if (title && titleEl) titleEl.textContent = title;
  if (desc && descEl) descEl.textContent = desc;

  const currentLicense = getActiveLicense();
  if (currentLicense && currentLicense.username && userInput) {
    userInput.value = currentLicense.username;
  }

  if (closeX) closeX.style.display = allowClose ? 'block' : 'none';
  if (modal) {
    modal.style.display = 'flex';
    if (keyInput) keyInput.focus();
  }
}

export function closeLicenseModal() {
  const license = getActiveLicense();
  if (!license) {
    const errDiv = document.getElementById('modal-err-msg');
    if (errDiv) errDiv.textContent = 'Activation is required before using the application.';
    return;
  }
  const modal = document.getElementById('license-modal');
  if (modal) modal.style.display = 'none';
}

export async function submitActivation() {
  const userInput = document.getElementById('input-license-user');
  const keyInput = document.getElementById('input-license-key');
  const errDiv = document.getElementById('modal-err-msg');

  const username = userInput.value.trim();
  const serialKey = keyInput.value.trim();

  errDiv.textContent = 'Verifying serial activation key with developer database...';
  errDiv.style.color = 'var(--color-accent-1)';

  try {
    const res = await activateLicense(username, serialKey);

    if (!res.success) {
      errDiv.style.color = 'var(--color-danger)';
      errDiv.textContent = res.error;
      return;
    }

    errDiv.style.color = 'var(--color-success)';
    errDiv.textContent = `✅ Successfully activated! Granted ${res.license.totalClicks} clicks quota.`;

    setTimeout(() => {
      document.getElementById('license-modal').style.display = 'none';
      keyInput.value = '';
      errDiv.textContent = '';
      updateLicenseUI();
    }, 1200);
  } catch (err) {
    console.error('License activation error:', err);
    errDiv.style.color = 'var(--color-danger)';
    errDiv.textContent = 'Verification error: ' + (err.message || err);
  }
}

// ============================================================
//  4. Day-Wise QR Generation History & Permanent Duplicate Registry
// ============================================================
// Retrieve all generated records across:
// 1. Permanent duplicate ledger (never cleared when user clears on-screen history)
// 2. Visible UI history
// 3. User history synced in GitHub / local license cache (multi-device)
export function getAllGeneratedRecords() {
  const map = new Map();

  function addRecord(item) {
    if (!item) return;
    let s = (item.startSerial || '').trim().toUpperCase();
    let e = (item.endSerial || '').trim().toUpperCase();
    if (s && e) {
      const sp = parseSerial(s);
      const ep = parseSerial(e);
      if (sp && ep && sp.prefix === ep.prefix) {
        try {
          if (BigInt(sp.num) > BigInt(ep.num)) {
            const tmp = s; s = e; e = tmp;
          }
        } catch (err) {}
      }
    }
    const key = `${(item.uan || '').trim().toLowerCase()}_${s}_${e}`;
    if (!map.has(key)) {
      map.set(key, { ...item, startSerial: s, endSerial: e });
    }
  }

  // 1. Permanent local ledger
  try {
    const rawPerm = localStorage.getItem(PERM_REGISTRY_KEY);
    if (rawPerm) {
      const permList = JSON.parse(rawPerm);
      if (Array.isArray(permList)) permList.forEach(addRecord);
    }
  } catch (e) {}

  // 2. Visible UI history
  try {
    const rawUi = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (rawUi) {
      const uiList = JSON.parse(rawUi);
      if (Array.isArray(uiList)) uiList.forEach(addRecord);
    }
  } catch (e) {}

  // 3. Synced GitHub / local license users history (multi-device)
  try {
    const licData = getLocalLicenses();
    if (licData && licData.users) {
      Object.values(licData.users).forEach(u => {
        if (Array.isArray(u.history)) {
          u.history.forEach(h => {
            if (h) {
              addRecord({
                uan: h.uan,
                startSerial: h.startSerial,
                endSerial: h.endSerial,
                count: h.count,
                dateFormatted: h.date || 'Previous session',
                timeFormatted: h.time || '',
                username: u.username || 'User'
              });
            }
          });
        }
      });
    }
  } catch (e) {}

  return Array.from(map.values());
}

// Duplicate checkers for UAN and Serial numbers
export function checkDuplicateUAN(uan) {
  if (!uan) return null;
  const records = getAllGeneratedRecords();
  const clean = uan.trim().toLowerCase();
  return records.find(h => (h.uan || '').trim().toLowerCase() === clean);
}

export function checkDuplicateSerial(startSerial, endSerial) {
  if (!startSerial) return null;
  const records = getAllGeneratedRecords();
  const sNorm = startSerial.trim().toUpperCase();
  const eNorm = (endSerial || '').trim().toUpperCase();

  const sp = parseSerial(sNorm);
  const ep = parseSerial(eNorm);

  for (const h of records) {
    if (sp && ep && h.startSerial && h.endSerial) {
      const hsp = parseSerial(h.startSerial);
      const hep = parseSerial(h.endSerial);
      if (hsp && hep && sp.prefix === hsp.prefix) {
        try {
          const sN = BigInt(sp.num);
          const eN = BigInt(ep.num);
          const hsN = BigInt(hsp.num);
          const heN = BigInt(hep.num);
          // Check if intervals [sN, eN] and [hsN, heN] overlap by even 1 single number
          if (sN <= heN && eN >= hsN) {
            const overlapStart = sN > hsN ? sN : hsN;
            const overlapEnd = eN < heN ? eN : heN;
            const overlapCount = Number(overlapEnd - overlapStart + 1n);
            const overlapStartStr = sp.prefix + overlapStart.toString().padStart(sp.digits, '0');
            const overlapEndStr = sp.prefix + overlapEnd.toString().padStart(sp.digits, '0');
            return {
              ...h,
              overlapCount,
              overlapStartStr,
              overlapEndStr
            };
          }
        } catch (e) {}
      }
    } else {
      if ((h.startSerial || '').toUpperCase() === sNorm || (h.endSerial || '').toUpperCase() === eNorm) {
        return { ...h, overlapCount: 1, overlapStartStr: sNorm, overlapEndStr: eNorm };
      }
    }
  }
  return null;
}

export function getQRHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    // Ensure startSerial is always the lower number and endSerial is higher
    return list.map(item => {
      if (item.startSerial && item.endSerial) {
        const sp = parseSerial(item.startSerial);
        const ep = parseSerial(item.endSerial);
        if (sp && ep && sp.prefix === ep.prefix) {
          try {
            if (BigInt(sp.num) > BigInt(ep.num)) {
              return {
                ...item,
                startSerial: item.endSerial,
                endSerial: item.startSerial
              };
            }
          } catch (e) {}
        }
      }
      return item;
    });
  } catch (e) {
    return [];
  }
}

export function saveQRHistoryBatch(batchRecord) {
  const history = getQRHistory();
  history.unshift(batchRecord);
  // Cap at 500 records
  if (history.length > 500) history.length = 500;
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));

  // Permanently record in duplicate ledger (NEVER deleted when user clears on-screen history)
  try {
    const rawPerm = localStorage.getItem(PERM_REGISTRY_KEY);
    const permList = rawPerm ? JSON.parse(rawPerm) : [];
    permList.unshift(batchRecord);
    if (permList.length > 10000) permList.length = 10000;
    localStorage.setItem(PERM_REGISTRY_KEY, JSON.stringify(permList));
  } catch (e) {}

  renderQRHistoryUI();
}

export function renderQRHistoryUI() {
  const container = document.getElementById('history-content');
  const totalBadge = document.getElementById('history-total-count');
  const footerActions = document.getElementById('history-footer-actions');
  if (!container) return;

  const history = getQRHistory();
  if (history.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: #94a3b8; font-size: 13px; padding: 16px;">No QR generation history yet. Generate your first PDF above!</div>`;
    if (totalBadge) totalBadge.textContent = '0 QRs Total';
    if (footerActions) footerActions.style.display = 'none';
    return;
  }

  // Calculate total QRs
  const totalQRs = history.reduce((sum, h) => sum + (h.count || 0), 0);
  if (totalBadge) totalBadge.textContent = `${totalQRs.toLocaleString()} QRs (${history.length} batches)`;
  if (footerActions) footerActions.style.display = 'flex';

  // Group by day (YYYY-MM-DD)
  const grouped = {};
  history.forEach(item => {
    const dKey = item.dateKey || item.dateFormatted || 'Unknown Date';
    if (!grouped[dKey]) {
      grouped[dKey] = {
        displayDate: item.dateFormatted || dKey,
        totalQRs: 0,
        batches: []
      };
    }
    grouped[dKey].totalQRs += (item.count || 0);
    grouped[dKey].batches.push(item);
  });

  const dayKeys = Object.keys(grouped);
  let html = '';

  dayKeys.forEach(dk => {
    const group = grouped[dk];
    html += `
      <div class="history-day-group">
        <div class="history-day-title">
          <span>📅 ${group.displayDate}</span>
          <span style="font-size:12px; color:#38bdf8; font-weight:600;">
            ${group.totalQRs.toLocaleString()} QRs &bull; ${group.batches.length} ${group.batches.length === 1 ? 'batch' : 'batches'}
          </span>
        </div>
        <div>
    `;

    group.batches.forEach(b => {
      html += `
        <div class="history-item">
          <div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span style="background:rgba(56,189,248,0.18); color:#38bdf8; font-weight:700; font-family:var(--font-mono); font-size:12px; padding:2px 8px; border-radius:5px; border:1px solid rgba(56,189,248,0.3);">
                UAN: ${b.uan || 'N/A'}
              </span>
              <strong style="font-family:var(--font-mono); color:#f8fafc; font-size:13px;">
                ${b.startSerial} &rarr; ${b.endSerial}
              </strong>
            </div>
            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">
              ⏰ ${b.timeFormatted || 'N/A'} &bull; File: 📄 ${b.uan ? b.uan + '.pdf' : 'PDF'} &bull; User: ${b.username || 'User'}
            </div>
          </div>
          <div style="text-align:right;">
            <span style="background:rgba(16,185,129,0.15); color:#34d399; font-weight:700; font-size:12px; padding:3px 8px; border-radius:6px; border:1px solid rgba(16,185,129,0.3);">
              ${b.count} QRs
            </span>
          </div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

export function toggleHistoryCollapse() {
  const content = document.getElementById('history-content');
  const icon = document.getElementById('history-toggle-icon');
  const footer = document.getElementById('history-footer-actions');
  if (!content) return;

  if (content.style.display === 'none') {
    content.style.display = 'block';
    if (icon) icon.textContent = '▼';
    if (footer) footer.style.display = 'flex';
  } else {
    content.style.display = 'none';
    if (icon) icon.textContent = '▲';
    if (footer) footer.style.display = 'none';
  }
}

export function clearUserHistory() {
  if (confirm('Clear on-screen generation history display?\n\nNote: Duplicate protection will remain active so previously generated UANs and serial numbers can never be duplicated.')) {
    localStorage.removeItem(HISTORY_STORAGE_KEY);
    renderQRHistoryUI();
  }
}

export function exportHistoryCSV() {
  const history = getQRHistory();
  if (history.length === 0) {
    alert('No history to export.');
    return;
  }

  let csv = 'Date,Time,UAN Number,Start Serial,End Serial,Count,User\n';
  history.forEach(h => {
    csv += `"${h.dateFormatted || ''}","${h.timeFormatted || ''}","${h.uan || ''}","${h.startSerial || ''}","${h.endSerial || ''}",${h.count || 0},"${h.username || ''}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `QR_Generation_History_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
//  5. Live Preview (Requirement 7: Preview is FREE, no quota used)
// ============================================================
let previewSerials = [];
let currentPreviewIndex = 0;

export async function startPreview() {
  const serials = getSelectedSerials();
  if (!serials) return;

  previewSerials = serials;
  currentPreviewIndex = 0;

  document.getElementById('progress-pdf').style.display = 'none';
  document.getElementById('info-pdf').style.display = 'none';
  document.getElementById('stats-pdf').style.display = 'none';
  document.getElementById('preview-pdf').style.display = 'block';

  await showPreviewQR(currentPreviewIndex);
}

async function showPreviewQR(index) {
  const container = document.getElementById('preview-single-qr');
  container.innerHTML = '';

  const serial = previewSerials[index];
  const encrypted = await encryptAESGCM(serial);

  const qrDataUrl = await QRCode.toDataURL(encrypted, {
    errorCorrectionLevel: 'H',
    width: 200,
    margin: 1
  });

  const img = document.createElement('img');
  img.src = qrDataUrl;
  img.alt = 'QR Code';
  img.style.width = '200px';
  img.style.height = '200px';
  img.style.display = 'block';
  container.appendChild(img);

  document.getElementById('preview-serial-text').textContent = serial;
  document.getElementById('preview-count-text').textContent = `Code ${index + 1} of ${previewSerials.length}`;

  document.getElementById('prev-btn').disabled = (index === 0);
  document.getElementById('next-btn').disabled = (index === previewSerials.length - 1);
}

export async function navigatePreview(direction) {
  const newIndex = currentPreviewIndex + direction;
  if (newIndex >= 0 && newIndex < previewSerials.length) {
    currentPreviewIndex = newIndex;
    await showPreviewQR(currentPreviewIndex);
  }
}

document.addEventListener('keydown', (e) => {
  if (document.getElementById('preview-pdf')?.style.display === 'block') {
    if (e.key === 'ArrowLeft') {
      navigatePreview(-1);
    } else if (e.key === 'ArrowRight') {
      navigatePreview(1);
    }
  }
});

function yieldToEventLoop() {
  if (typeof MessageChannel !== 'undefined') {
    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise(r => setTimeout(r, 0));
}

// ============================================================
//  6. PDF Generation (Consumes 1 Click per tap, Syncs to GitHub)
// ============================================================
export async function generatePDF() {
  const serials = getSelectedSerials();
  if (!serials) return;
  const count = serials.length;

  const startSerial = (document.getElementById('start-pdf')?.value || '').trim().toUpperCase();
  const endSerial = (document.getElementById('end-pdf')?.value || '').trim().toUpperCase();

  // 1. Validate Enter UAN Number field
  const uanInput = document.getElementById('uan-pdf');
  const uanErr = document.getElementById('uan-err');
  const uanVal = (uanInput?.value || '').trim();

  if (!uanVal) {
    if (uanErr) uanErr.textContent = '❌ Please enter UAN Number';
    if (uanInput) {
      uanInput.classList.add('input-invalid');
      uanInput.focus();
    }
    alert('❌ UAN Number Required!\n\nPlease enter the UAN Number before generating the PDF.');
    return;
  }

  // 2. Check for Duplicate UAN Number
  const dupUan = checkDuplicateUAN(uanVal);
  if (dupUan) {
    if (uanErr) uanErr.textContent = `❌ Duplicate UAN: Already generated on ${dupUan.dateFormatted}`;
    if (uanInput) uanInput.classList.add('input-invalid');
    alert(`❌ Duplicate UAN Error!\n\nUAN Number "${uanVal}" has already been generated previously on ${dupUan.dateFormatted} at ${dupUan.timeFormatted}!\n\nEach UAN Number must be unique and cannot be entered twice.`);
    return;
  }
  if (uanErr) uanErr.textContent = '';
  if (uanInput) uanInput.classList.remove('input-invalid');

  // 3. Check for Duplicate Serial Number (even 1 matching serial among 580 triggers error)
  const dupSerial = checkDuplicateSerial(startSerial, endSerial);
  if (dupSerial) {
    const startErr = document.getElementById('start-serial-err');
    const overlapText = dupSerial.overlapCount
      ? `${dupSerial.overlapCount} matching serial(s) in UAN: ${dupSerial.uan || 'N/A'}`
      : `Used in UAN: ${dupSerial.uan || 'N/A'}`;
    if (startErr) startErr.textContent = `❌ Duplicate: ${overlapText}`;
    const startInput = document.getElementById('start-pdf');
    if (startInput) startInput.classList.add('input-invalid');

    const countDetail = dupSerial.overlapCount
      ? `${dupSerial.overlapCount} serial number(s) in this batch have already been generated`
      : `Serial number range "${startSerial} → ${endSerial}" has already been generated`;

    alert(`❌ Duplicate Serial Number Error!\n\n${countDetail} previously in UAN: "${dupSerial.uan || 'N/A'}" on ${dupSerial.dateFormatted}!\n\nOverlapping Range: ${dupSerial.overlapStartStr || startSerial} → ${dupSerial.overlapEndStr || endSerial}\n\nNotice: Even if only ONE serial number out of the 580 matches a previous UAN, generation is strictly blocked!`);
    return;
  }

  // 4. Validate Click Quota First (Requirement 6 & 7: 1 tap = 1 click)
  const canProceed = consumeClickQuota();
  if (!canProceed) return;

  const activeLic = getActiveLicense();
  const username = activeLic ? activeLic.username : 'User';

  // Show progress
  document.getElementById('progress-pdf').style.display = 'block';
  document.getElementById('info-pdf').style.display = 'block';
  document.getElementById('stats-pdf').style.display = 'grid';
  document.getElementById('preview-pdf').style.display = 'none';

  const codesPerPage = 20;
  const numPages = Math.ceil(count / codesPerPage);
  document.getElementById('s-total-pdf').textContent = count;
  document.getElementById('s-pages-pdf').textContent = numPages;
  document.getElementById('gen-btn').disabled = true;

  try {
    const pdf = new jsPDF({orientation: 'portrait', unit: 'mm', format: 'a4'});

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 15;
    const cols = 4;
    const rows = 5;
    const horizontalSpacing = 15;
    const verticalSpacing = 12;
    const qrWidth = (pageWidth - 2 * margin - (cols - 1) * horizontalSpacing) / cols;
    const qrHeight = qrWidth + 8;

    let codeIdx = 0;

    for (let pageNum = 0; pageNum < numPages; pageNum++) {
      if (pageNum > 0) pdf.addPage();

      // Header with UAN Number
      pdf.setFontSize(11);
      pdf.text(`Random Encrypted QR Codes - UAN: ${uanVal} - Page ${pageNum + 1} of ${numPages}`, margin, margin);

      let yPos = margin + 12;

      for (let row = 0; row < rows && codeIdx < serials.length; row++) {
        for (let col = 0; col < cols && codeIdx < serials.length; col++) {
          const serial = serials[codeIdx];
          const encrypted = await encryptAESGCM(serial);

          const qrDataUrl = await QRCode.toDataURL(encrypted, {
            errorCorrectionLevel: 'H',
            width: 120,
            margin: 0,
            type: 'image/jpeg',
            rendererOpts: { quality: 0.75 }
          });

          if (codeIdx % 5 === 0) {
            await yieldToEventLoop();
          }

          const xPos = margin + col * (qrWidth + horizontalSpacing);
          const yPosQR = yPos + row * (qrHeight + verticalSpacing);

          pdf.addImage(qrDataUrl, 'JPEG', xPos, yPosQR, qrWidth, qrWidth, undefined, 'FAST');

          // Label
          pdf.setFontSize(6);
          const label = `${serial}`;
          pdf.text(label, xPos + (qrWidth/2), yPosQR + qrWidth + 3, {align: 'center', maxWidth: qrWidth + horizontalSpacing});

          codeIdx++;

          const progress = (codeIdx / serials.length) * 100;
          document.getElementById('progress-fill-pdf').style.width = progress + '%';
        }
      }

      // Footer with UAN Number
      pdf.setFontSize(7);
      pdf.text(`UAN: ${uanVal} | Codes ${pageNum * codesPerPage + 1} - ${Math.min((pageNum + 1) * codesPerPage, serials.length)}`, margin, pageHeight - 5);
      pdf.text('PPS Random QR Generator', pageWidth - margin - 30, pageHeight - 5);
    }

    // Record Batch into Day-Wise History (saved with UAN Number)
    const now = new Date();
    const batchRecord = {
      id: 'batch_' + Date.now(),
      timestamp: Date.now(),
      dateKey: now.toISOString().slice(0, 10),
      dateFormatted: now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
      timeFormatted: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      uan: uanVal,
      startSerial: startSerial,
      endSerial: endSerial,
      count: count,
      username: username
    };
    saveQRHistoryBatch(batchRecord);

    // Sync 1 Click and Batch Details to GitHub (with UAN)
    await recordUserClick(username, {
      date: batchRecord.dateKey,
      time: batchRecord.timeFormatted,
      uan: uanVal,
      startSerial: startSerial,
      endSerial: endSerial,
      count: count
    });

    // File Download Logic: Renamed with this UAN Number only
    const safeUan = uanVal.replace(/[/\\?%*:|"<>]/g, '_');
    const fileName = `${safeUan}.pdf`;

    if (Capacitor.isNativePlatform()) {
      document.getElementById('info-pdf').textContent = 'Preparing native file download...';
      await new Promise(r => setTimeout(r, 100));

      try {
        await Filesystem.requestPermissions();
      } catch (permErr) {
        console.warn('Filesystem permissions request warning:', permErr);
      }

      const pdfBlob = pdf.output('blob');
      const pdfBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = reader.result;
          resolve(res.substring(res.indexOf(',') + 1));
        };
        reader.onerror = reject;
        reader.readAsDataURL(pdfBlob);
      });

      let writeResult;
      let saveLocation = 'Documents (Mobile Drive)';

      try {
        writeResult = await Filesystem.writeFile({
          path: fileName,
          data: pdfBase64,
          directory: Directory.Documents,
          recursive: true
        });
      } catch (docErr) {
        console.warn('Could not write to Documents directory, falling back to Cache:', docErr);
        saveLocation = 'App Storage';
        writeResult = await Filesystem.writeFile({
          path: fileName,
          data: pdfBase64,
          directory: Directory.Cache,
          recursive: true
        });
      }

      await new Promise(r => setTimeout(r, 200));

      try {
        await Share.share({
          title: fileName,
          text: `QR Codes PDF (${count} codes)`,
          url: writeResult.uri,
          dialogTitle: 'Save or Share PDF'
        });
      } catch (shareErr) {
        console.warn('Share dialog cancelled or failed:', shareErr);
      }

      document.getElementById('progress-pdf').style.display = 'none';
      document.getElementById('success-pdf').textContent = `✅ PDF saved to ${saveLocation}! (${count} QR codes, ${numPages} pages)`;
      document.getElementById('success-pdf').style.display = 'block';
    } else {
      pdf.save(fileName);
      document.getElementById('progress-pdf').style.display = 'none';
      document.getElementById('success-pdf').textContent = `✅ PDF generated successfully! (${count} QR codes, ${numPages} pages)`;
      document.getElementById('success-pdf').style.display = 'block';
    }
  } catch (error) {
    document.getElementById('err-pdf').textContent = 'Error generating PDF: ' + error.message;
  } finally {
    document.getElementById('gen-btn').disabled = false;
  }
}

// ============================================================
//  6b. Slideshow Link (self-contained HTML page, one QR at a time)
// ============================================================
function buildSlideshowHTML(uanVal, serials, images) {
  const data = JSON.stringify({ uan: uanVal, serials, images });
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Viewer - ${String(uanVal).replace(/[<>&"]/g, '')}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:12px}
h1{font-size:15px;font-weight:600;margin-bottom:8px;text-align:center}
.stage{display:flex;align-items:center;gap:10px;width:100%;max-width:640px;justify-content:center}
.qrbox{background:#fff;padding:14px;border-radius:14px;flex:0 1 auto}
.qrbox img{display:block;width:min(70vw,420px);height:min(70vw,420px);image-rendering:pixelated}
.nav{width:52px;height:90px;border:none;border-radius:12px;background:#334155;color:#fff;font-size:28px;cursor:pointer}
.nav:active{background:#6366f1}
.serial{margin-top:10px;font-family:ui-monospace,Consolas,monospace;font-size:18px;letter-spacing:1px}
.count{font-size:13px;color:#94a3b8;margin-top:2px}
.bar{width:100%;max-width:640px;height:6px;background:#1e293b;border-radius:3px;margin:10px 0;overflow:hidden}
.bar div{height:100%;width:0;background:linear-gradient(90deg,#6366f1,#22d3ee)}
.ctl{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center;max-width:640px}
.ctl button,.ctl input{height:42px;border-radius:10px;border:1px solid #475569;background:#1e293b;color:#fff;font-size:15px;padding:0 14px}
.ctl input{width:78px;text-align:center}
#play{background:#16a34a;border-color:#16a34a;font-weight:600}
#play.on{background:#dc2626;border-color:#dc2626}
label{font-size:13px;color:#94a3b8}
</style></head><body>
<h1>UAN: <span id="uan"></span></h1>
<div class="stage"><button class="nav" id="prev">&#8249;</button><div class="qrbox"><img id="qr" alt="QR"></div><button class="nav" id="next">&#8250;</button></div>
<div class="serial" id="serial"></div><div class="count" id="count"></div>
<div class="bar"><div id="fill"></div></div>
<div class="ctl">
<button id="play">&#9654; Auto Play</button>
<label>Seconds <input id="secs" type="number" min="0.5" step="0.5" value="2"></label>
<label>Go to # <input id="jump" type="number" min="1" value="1"></label>
<button id="go">Go</button>
<button id="fs">Full Screen</button>
</div>
<script>
var D=${data},i=0,timer=null,$=function(x){return document.getElementById(x)};
$('uan').textContent=D.uan;
function show(n){var t=D.images.length;i=(n+t)%t;$('qr').src=D.images[i];$('serial').textContent=D.serials[i];$('count').textContent='QR '+(i+1)+' of '+t;$('fill').style.width=((i+1)/t*100)+'%';$('jump').value=i+1}
function stop(){clearInterval(timer);timer=null;$('play').textContent='\u25B6 Auto Play';$('play').className=''}
function start(){var s=Math.max(0.5,parseFloat($('secs').value)||2);stop();timer=setInterval(function(){if(i>=D.images.length-1){stop();return}show(i+1)},s*1000);$('play').textContent='\u275A\u275A Pause';$('play').className='on'}
$('prev').onclick=function(){show(i-1)};$('next').onclick=function(){show(i+1)};
$('play').onclick=function(){timer?stop():start()};
$('secs').onchange=function(){if(timer)start()};
$('go').onclick=function(){show((parseInt($('jump').value)||1)-1)};
$('fs').onclick=function(){var e=document.documentElement;(e.requestFullscreen||e.webkitRequestFullscreen||function(){}).call(e)};
document.onkeydown=function(e){if(e.key==='ArrowRight')show(i+1);else if(e.key==='ArrowLeft')show(i-1);else if(e.key===' '){e.preventDefault();timer?stop():start()}};
show(0);
</script></body></html>`;
}

export async function generateSlideshowLink() {
  const serials = getSelectedSerials();
  if (!serials) return;
  const count = serials.length;

  const startSerial = (document.getElementById('start-pdf')?.value || '').trim().toUpperCase();
  const endSerial = (document.getElementById('end-pdf')?.value || '').trim().toUpperCase();

  const uanInput = document.getElementById('uan-pdf');
  const uanErr = document.getElementById('uan-err');
  const uanVal = (uanInput?.value || '').trim();

  if (!uanVal) {
    if (uanErr) uanErr.textContent = '❌ Please enter UAN Number';
    if (uanInput) { uanInput.classList.add('input-invalid'); uanInput.focus(); }
    alert('❌ UAN Number Required!\n\nPlease enter the UAN Number before generating the link.');
    return;
  }

  const dupUan = checkDuplicateUAN(uanVal);
  if (dupUan) {
    if (uanErr) uanErr.textContent = `❌ Duplicate UAN: Already generated on ${dupUan.dateFormatted}`;
    if (uanInput) uanInput.classList.add('input-invalid');
    alert(`❌ Duplicate UAN Error!\n\nUAN Number "${uanVal}" has already been generated previously on ${dupUan.dateFormatted} at ${dupUan.timeFormatted}!`);
    return;
  }
  if (uanErr) uanErr.textContent = '';
  if (uanInput) uanInput.classList.remove('input-invalid');

  const dupSerial = checkDuplicateSerial(startSerial, endSerial);
  if (dupSerial) {
    const startErr = document.getElementById('start-serial-err');
    if (startErr) startErr.textContent = `❌ Duplicate: Used in UAN: ${dupSerial.uan || 'N/A'}`;
    alert(`❌ Duplicate Serial Number Error!\n\nSerial range "${startSerial} → ${endSerial}" overlaps a previous UAN: "${dupSerial.uan || 'N/A'}" on ${dupSerial.dateFormatted}!`);
    return;
  }

  const canProceed = consumeClickQuota();
  if (!canProceed) return;

  const activeLic = getActiveLicense();
  const username = activeLic ? activeLic.username : 'User';

  document.getElementById('progress-pdf').style.display = 'block';
  document.getElementById('preview-pdf').style.display = 'none';
  document.getElementById('success-pdf').style.display = 'none';
  document.getElementById('err-pdf').textContent = '';
  document.getElementById('gen-btn').disabled = true;
  const linkBtn = document.getElementById('link-btn');
  if (linkBtn) linkBtn.disabled = true;

  try {
    const images = [];
    for (let i = 0; i < serials.length; i++) {
      const encrypted = await encryptAESGCM(serials[i]);
      images.push(await QRCode.toDataURL(encrypted, {
        errorCorrectionLevel: 'H',
        width: 300,
        margin: 2
      }));
      if (i % 5 === 0) await yieldToEventLoop();
      document.getElementById('progress-fill-pdf').style.width = ((i + 1) / serials.length * 100) + '%';
    }

    const html = buildSlideshowHTML(uanVal, serials, images);

    const now = new Date();
    const batchRecord = {
      id: 'batch_' + Date.now(),
      timestamp: Date.now(),
      dateKey: now.toISOString().slice(0, 10),
      dateFormatted: now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
      timeFormatted: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      uan: uanVal,
      startSerial: startSerial,
      endSerial: endSerial,
      count: count,
      username: username
    };
    saveQRHistoryBatch(batchRecord);

    await recordUserClick(username, {
      date: batchRecord.dateKey,
      time: batchRecord.timeFormatted,
      uan: uanVal,
      startSerial: startSerial,
      endSerial: endSerial,
      count: count
    });

    const safeUan = uanVal.replace(/[/\\\\?%*:|"<>]/g, '_');
    const fileName = `${safeUan}.html`;

    if (Capacitor.isNativePlatform()) {
      try { await Filesystem.requestPermissions(); } catch (e) { console.warn(e); }

      const bytes = new TextEncoder().encode(html);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      const b64 = btoa(bin);

      let writeResult;
      let saveLocation = 'Documents (Mobile Drive)';
      try {
        writeResult = await Filesystem.writeFile({ path: fileName, data: b64, directory: Directory.Documents, recursive: true });
      } catch (docErr) {
        saveLocation = 'App Storage';
        writeResult = await Filesystem.writeFile({ path: fileName, data: b64, directory: Directory.Cache, recursive: true });
      }
      try {
        await Share.share({ title: fileName, text: `QR Slideshow (${count} codes)`, url: writeResult.uri, dialogTitle: 'Save or Share QR Slideshow' });
      } catch (shareErr) {
        console.warn('Share dialog cancelled or failed:', shareErr);
      }
      document.getElementById('success-pdf').textContent = `✅ QR slideshow saved to ${saveLocation}! (${count} QR codes) Open the .html file in a browser.`;
    } else {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      document.getElementById('success-pdf').textContent = `✅ QR slideshow generated! (${count} QR codes) Open the downloaded .html file.`;
    }
    document.getElementById('progress-pdf').style.display = 'none';
    document.getElementById('success-pdf').style.display = 'block';
  } catch (error) {
    document.getElementById('err-pdf').textContent = 'Error generating link: ' + error.message;
  } finally {
    document.getElementById('gen-btn').disabled = false;
    if (linkBtn) linkBtn.disabled = false;
  }
}

// ============================================================
//  7. Initialization & Event Attachments
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('SW registered: ', reg))
      .catch(err => console.log('SW registration failed: ', err));
  });
}

// Window attachments for inline handlers
window.startPreview = startPreview;
window.generatePDF = generatePDF;
window.generateSlideshowLink = generateSlideshowLink;
window.navigatePreview = navigatePreview;
window.openLicenseModal = openLicenseModal;
window.closeLicenseModal = closeLicenseModal;
window.submitActivation = submitActivation;
window.autoFillEndSerial = autoFillEndSerial;
window.toggleHistoryCollapse = toggleHistoryCollapse;
window.clearUserHistory = clearUserHistory;
window.exportHistoryCSV = exportHistoryCSV;
window.syncLatestQuotaFromGitHub = syncLatestQuotaFromGitHub;

window.addEventListener('DOMContentLoaded', () => {
  updateLicenseUI();
  syncLatestQuotaFromGitHub(false);
  renderQRHistoryUI();

  // Attach UAN listeners
  const uanInput = document.getElementById('uan-pdf');
  const uanErr = document.getElementById('uan-err');
  if (uanInput) {
    const handleUanChange = () => {
      const val = uanInput.value.trim();
      if (!val) {
        if (uanErr) uanErr.textContent = '';
        uanInput.classList.remove('input-invalid');
        return;
      }
      const dup = checkDuplicateUAN(val);
      if (dup) {
        if (uanErr) uanErr.textContent = `❌ Duplicate UAN: Used on ${dup.dateFormatted}`;
        uanInput.classList.add('input-invalid');
      } else {
        if (uanErr) uanErr.textContent = '';
        uanInput.classList.remove('input-invalid');
      }
    };
    uanInput.addEventListener('input', handleUanChange);
    uanInput.addEventListener('change', handleUanChange);
    uanInput.addEventListener('paste', () => setTimeout(handleUanChange, 0));
  }

  // Attach 14-char listeners
  const startInput = document.getElementById('start-pdf');
  const endInput = document.getElementById('end-pdf');

  if (startInput) {
    const handleStartChange = () => {
      validate14CharSerial(startInput.value, 'start');
      autoFillEndSerial();
    };
    startInput.addEventListener('input', handleStartChange);
    startInput.addEventListener('change', handleStartChange);
    startInput.addEventListener('paste', () => setTimeout(handleStartChange, 0));
    // Initial validation
    if (startInput.value) {
      validate14CharSerial(startInput.value, 'start');
      autoFillEndSerial();
    }
  }

  if (endInput) {
    const handleEndChange = () => {
      validate14CharSerial(endInput.value, 'end');
    };
    endInput.addEventListener('input', handleEndChange);
    endInput.addEventListener('change', handleEndChange);
    endInput.addEventListener('paste', () => setTimeout(handleEndChange, 0));
    if (endInput.value) {
      validate14CharSerial(endInput.value, 'end');
    }
  }

  // Check active license
  const activeLic = getActiveLicense();
  if (!activeLic) {
    setTimeout(() => {
      openLicenseModal(false, 'App Activation Required', 'Please register with the Username and Serial Key provided by the developer.');
    }, 300);
  }

  // Cross-device synchronization triggers:
  // Re-sync quota automatically when user switches back to this tab / unlocks phone
  window.addEventListener('focus', () => {
    syncLatestQuotaFromGitHub(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncLatestQuotaFromGitHub(false);
    }
  });
  // Background periodic sync every 30 seconds
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      syncLatestQuotaFromGitHub(false);
    }
  }, 30000);
});

