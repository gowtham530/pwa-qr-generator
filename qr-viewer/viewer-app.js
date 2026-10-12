import QRCode from 'qrcode';

// ============================================================
// Secure Mill QR Viewer Engine
// - Device ID Whitelisting & Verification
// - 24-Hour Authoritative Network Time Expiration
// - Clock Anti-Rollback Safeguards
// - High-Contrast Mill Hardware Scanner Display
// ============================================================

const DEVICE_ID_KEY = 'qr_viewer_device_id_v1';
const ACTIVE_BATCH_KEY = 'qr_viewer_active_batch_v1';
const LAST_TIME_KEY = 'qr_viewer_last_known_timestamp_v1';
const NETWORK_TIME_API = 'https://genqr580.netlify.app/api/qr-service?action=get_time';

// ------------------------------------------------------------
// 1. Device ID Generation & Storage
// ------------------------------------------------------------
function getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    // Generate persistent 8-character alphanumeric Device ID
    const randomBytes = new Uint8Array(4);
    crypto.getRandomValues(randomBytes);
    const hex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    id = `DEV-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

// ------------------------------------------------------------
// 2. Authoritative Network Time & Anti-Rollback Check
// ------------------------------------------------------------
async function getAuthoritativeTime() {
  let serverTime = null;
  const statusEl = document.getElementById('network-status-text');
  const dotEl = document.getElementById('network-dot');

  try {
    const res = await fetch(`${NETWORK_TIME_API}&_t=${Date.now()}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.serverTime) {
        serverTime = Number(data.serverTime);
        if (statusEl) statusEl.textContent = 'Network Clock Synced (genqr580.netlify.app)';
        if (dotEl) dotEl.style.background = '#10b981';
      }
    }
  } catch (e) {
    console.warn('Network time check failed, using device clock with anti-rollback validation:', e);
    if (statusEl) statusEl.textContent = 'Offline Mode (Device Clock Protected)';
    if (dotEl) dotEl.style.background = '#f59e0b';
  }

  const effectiveTime = serverTime || Date.now();

  // Anti-Rollback Check:
  const lastKnown = Number(localStorage.getItem(LAST_TIME_KEY) || '0');
  if (effectiveTime < lastKnown - 60000) { // If time was rolled back by > 1 minute
    throw new Error('⚠️ System Clock Tampering Detected: The device clock was moved backwards. Please restore automatic network time to continue.');
  }

  // Update highest known timestamp
  if (effectiveTime > lastKnown) {
    localStorage.setItem(LAST_TIME_KEY, String(effectiveTime));
  }

  return effectiveTime;
}

// ------------------------------------------------------------
// 3. State Management
// ------------------------------------------------------------
let activeBatch = null;
let currentItemIndex = 0;
let countdownTimerInterval = null;

// Format duration
function formatRemainingTime(ms) {
  if (ms <= 0) return 'Expired (0m left)';
  const totalMinutes = Math.floor(ms / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m left`;
}

function formatDate(timestamp) {
  try {
    return new Date(timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (e) {
    return String(timestamp);
  }
}

// ------------------------------------------------------------
// 4. File Processing & Security Validation
// ------------------------------------------------------------
async function loadQRPFile(file) {
  showAlert(null); // clear alert

  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      throw new Error('Invalid file format: This file is not a valid .QRP package.');
    }

    if (data.magic !== 'QRP580' || !Array.isArray(data.items) || data.items.length === 0) {
      throw new Error('Unsupported format: This file is not a valid QR Generator (.QRP) batch.');
    }

    // 1. Device ID Check: Must match this device!
    const myDeviceId = getOrCreateDeviceId();
    const targetDevId = String(data.targetDeviceId || '').trim().toUpperCase();

    if (!targetDevId || targetDevId !== myDeviceId.toUpperCase()) {
      throw new Error(
        `❌ Unauthorized Device!\n\n` +
        `This .QRP file is locked to device "${targetDevId}".\n` +
        `Your device ID is "${myDeviceId}".\n\n` +
        `Please request a .QRP file generated specifically for your Device ID from the Mill Office.`
      );
    }

    // 2. Authoritative Time & 24-Hour Expiration Check
    const nowTime = await getAuthoritativeTime();
    const expiresAt = Number(data.expiresAt || (data.serverTime + (24 * 60 * 60 * 1000)));

    if (nowTime > expiresAt) {
      throw new Error(
        `❌ Batch Expired!\n\n` +
        `The 24-hour scanning window for this batch ended on ${formatDate(expiresAt)}.\n\n` +
        `This file can no longer be viewed. Please contact the Mill Office for a new file.`
      );
    }

    // Checks passed! Activate batch
    activeBatch = data;

    // Restore previously saved index for this specific UAN if paused earlier
    const savedState = localStorage.getItem(`${ACTIVE_BATCH_KEY}_${data.uan}`);
    if (savedState) {
      try {
        const parsed = JSON.parse(savedState);
        if (typeof parsed.index === 'number' && parsed.index >= 0 && parsed.index < data.items.length) {
          currentItemIndex = parsed.index;
        } else {
          currentItemIndex = 0;
        }
      } catch (e) {
        currentItemIndex = 0;
      }
    } else {
      currentItemIndex = 0;
    }

    renderActiveBatchUI();
  } catch (err) {
    showAlert(err.message);
  }
}

// ------------------------------------------------------------
// 5. Active Batch UI & QR Code Rendering
// ------------------------------------------------------------
function renderActiveBatchUI() {
  if (!activeBatch) return;

  const importSection = document.getElementById('import-section');
  const scannerSection = document.getElementById('scanner-section');
  const uanText = document.getElementById('batch-uan-text');
  const slider = document.getElementById('bag-slider');
  const numInput = document.getElementById('bag-number-input');

  importSection.style.display = 'none';
  scannerSection.style.display = 'flex';

  uanText.textContent = `UAN: ${activeBatch.uan}`;
  const total = activeBatch.items.length;

  slider.max = total;
  numInput.max = total;

  startCountdownTimer();
  renderCurrentQR();
}

function startCountdownTimer() {
  if (countdownTimerInterval) clearInterval(countdownTimerInterval);

  const updateTimer = async () => {
    if (!activeBatch) return;
    try {
      const nowTime = await getAuthoritativeTime();
      const expiresAt = Number(activeBatch.expiresAt);
      const remainingMs = expiresAt - nowTime;

      const timerEl = document.getElementById('batch-timer-text');
      if (remainingMs <= 0) {
        clearInterval(countdownTimerInterval);
        closeBatch();
        showAlert(`❌ 24-Hour Scanning Window Expired: The file has now expired and was closed.`);
        return;
      }

      timerEl.textContent = `⏳ ${formatRemainingTime(remainingMs)}`;
      if (remainingMs < 3600000) { // less than 1 hr
        timerEl.classList.add('urgent');
      } else {
        timerEl.classList.remove('urgent');
      }
    } catch (e) {
      console.warn('Timer check error:', e);
    }
  };

  updateTimer();
  countdownTimerInterval = setInterval(updateTimer, 60000); // update every minute
}

async function renderCurrentQR() {
  if (!activeBatch || !activeBatch.items || activeBatch.items.length === 0) return;

  const total = activeBatch.items.length;
  if (currentItemIndex < 0) currentItemIndex = 0;
  if (currentItemIndex >= total) currentItemIndex = total - 1;

  const item = activeBatch.items[currentItemIndex];
  const holder = document.getElementById('qr-canvas-holder');
  const bagBadge = document.getElementById('bag-badge-text');
  const serialText = document.getElementById('serial-display-text');
  const progressFill = document.getElementById('progress-bar-fill');
  const slider = document.getElementById('bag-slider');
  const numInput = document.getElementById('bag-number-input');

  bagBadge.textContent = `Bag ${currentItemIndex + 1} of ${total}`;
  serialText.textContent = item.serial;

  slider.value = currentItemIndex + 1;
  numInput.value = currentItemIndex + 1;

  const pct = Math.round(((currentItemIndex + 1) / total) * 100);
  progressFill.style.width = `${pct}%`;

  // Render high-contrast QR matrix for Mill Hardware Scanner
  holder.innerHTML = '';
  const canvas = document.createElement('canvas');
  holder.appendChild(canvas);

  try {
    await QRCode.toCanvas(canvas, item.encrypted, {
      errorCorrectionLevel: 'H',
      width: 290,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
  } catch (err) {
    console.error('QR rendering error:', err);
    holder.textContent = '❌ Error rendering QR Code';
  }

  // Save progress so user can pause and resume
  localStorage.setItem(`${ACTIVE_BATCH_KEY}_${activeBatch.uan}`, JSON.stringify({
    index: currentItemIndex,
    lastViewedAt: Date.now()
  }));
}

function nextBag() {
  if (!activeBatch) return;
  if (currentItemIndex < activeBatch.items.length - 1) {
    currentItemIndex++;
    renderCurrentQR();
  }
}

function prevBag() {
  if (!activeBatch) return;
  if (currentItemIndex > 0) {
    currentItemIndex--;
    renderCurrentQR();
  }
}

function jumpToBag(num) {
  if (!activeBatch) return;
  const idx = parseInt(num, 10) - 1;
  if (!isNaN(idx) && idx >= 0 && idx < activeBatch.items.length) {
    currentItemIndex = idx;
    renderCurrentQR();
  }
}

function closeBatch() {
  if (countdownTimerInterval) clearInterval(countdownTimerInterval);
  activeBatch = null;
  document.getElementById('scanner-section').style.display = 'none';
  document.getElementById('import-section').style.display = 'flex';
  document.getElementById('file-input').value = '';
}

function showAlert(msg) {
  const alertBanner = document.getElementById('alert-banner');
  const alertDesc = document.getElementById('alert-desc');
  if (!msg) {
    alertBanner.style.display = 'none';
    return;
  }
  alertDesc.textContent = msg;
  alertBanner.style.display = 'flex';
}

// ------------------------------------------------------------
// 6. Initialization
// ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const deviceId = getOrCreateDeviceId();
  const deviceDisplay = document.getElementById('my-device-id');
  if (deviceDisplay) {
    deviceDisplay.textContent = deviceId;
  }

  // Copy Device ID Button
  const btnCopy = document.getElementById('btn-copy-device');
  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(deviceId);
        alert(`✅ Device ID copied to clipboard!\n\nDevice ID: ${deviceId}\n\nShare this ID with the developer to authorize your device.`);
      } catch (e) {
        prompt('Copy your Device ID below:', deviceId);
      }
    });
  }

  // File Input Handler
  const fileInput = document.getElementById('file-input');
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) loadQRPFile(file);
    });
  }

  // Navigation Buttons
  document.getElementById('btn-next-bag')?.addEventListener('click', nextBag);
  document.getElementById('btn-prev-bag')?.addEventListener('click', prevBag);

  // Jump input & slider
  const slider = document.getElementById('bag-slider');
  const numInput = document.getElementById('bag-number-input');

  if (slider) {
    slider.addEventListener('input', (e) => jumpToBag(e.target.value));
  }
  if (numInput) {
    numInput.addEventListener('change', (e) => jumpToBag(e.target.value));
  }

  // Close / Eject button
  document.getElementById('btn-eject')?.addEventListener('click', () => {
    if (confirm('Close current batch and return to file selection? Your progress will be saved.')) {
      closeBatch();
    }
  });

  // Keyboard navigation (Left / Right Arrow)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') {
      nextBag();
    } else if (e.key === 'ArrowLeft') {
      prevBag();
    }
  });

  // Initial network time ping
  getAuthoritativeTime();
});
