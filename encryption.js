// ============================================================
//  AES-256-GCM Encryption Module
//  Used for: QR Code content encryption
//  Algorithm: AES-256-GCM (Authenticated Encryption)
// ============================================================

// -----------------------------------------------------------
// 1. SECRET KEY & IV (Initialization Vector / Nonce)
//    KEY : 64 hex chars = 32 bytes = AES-256 key
//    IV  : 24 hex chars = 12 bytes = GCM standard nonce size
// -----------------------------------------------------------
const KEY_HEX = 'fdeffaeff7efbfeffd72fefceffcef2fefefcfefefefefeffa2eeff7feefef75';
const IV_HEX  = 'ffeffaefefefefc5a7efef9c';

// -----------------------------------------------------------
// 2. HELPER: Convert hex string  -->  Uint8Array of bytes
//    Input  : "fdef12..." (hex string)
//    Output : Uint8Array [253, 239, 18, ...]
// -----------------------------------------------------------
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

// -----------------------------------------------------------
// 3. HELPER: Convert Uint8Array of bytes  -->  hex string
//    Input  : Uint8Array [253, 239, 18, ...]
//    Output : "fdef12..." (hex string)
// -----------------------------------------------------------
function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// -----------------------------------------------------------
// 4. MAIN: Encrypt a plaintext string using AES-256-GCM
//
//    Input  : plaintext string (e.g. serial number "AP25R002006761")
//    Output : encrypted hex string (to be embedded in QR code)
//
//    Flow:
//      plaintext (string)
//        --> TextEncoder --> UTF-8 bytes
//        --> AES-256-GCM encrypt (KEY_HEX + IV_HEX)
//        --> ciphertext bytes  +  16-byte GCM auth tag
//        --> bytesToHex()
//        --> hex string  (use this as QR code content)
// -----------------------------------------------------------
async function encryptAESGCM(plaintext) {
  const key = hexToBytes(KEY_HEX);   // 32-byte raw key
  const iv  = hexToBytes(IV_HEX);    // 12-byte nonce

  // Convert plaintext string to UTF-8 bytes
  const pt = new TextEncoder().encode(plaintext);

  // Import the raw key for AES-GCM encryption
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-GCM' },
    false,          // not extractable
    ['encrypt']     // usage: encrypt only
  );

  // Encrypt using AES-GCM
  // Output = ciphertext + 16-byte authentication tag (auto-appended by GCM)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    cryptoKey,
    pt
  );

  // Return as hex string
  return bytesToHex(new Uint8Array(encrypted));
}

// -----------------------------------------------------------
// USAGE EXAMPLE:
//
//   const serial   = 'AP25R002006761';
//   const qrText   = await encryptAESGCM(serial);
//
//   new QRCode(container, {
//     text: qrText,
//     width: 200,
//     height: 200,
//     correctLevel: QRCode.CorrectLevel.H
//   });
// -----------------------------------------------------------

// Export for use in other modules (remove if using in <script> tag directly)
// export { encryptAESGCM, hexToBytes, bytesToHex };
