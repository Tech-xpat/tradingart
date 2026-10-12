/**
 * The exact texts users sign. Built and parsed here so the web app and the worker agree byte for byte.
 * A user always sees these in plain language in their own wallet before signing.
 * This file is byte-identical in web/lib/messages.js and worker/src/vault/messages.js (a test enforces it).
 */
const CONSENT_VERSION = 'v1';

function signInMessage({ domain, wallet, nonce, issuedAt, expiresAt }) {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    '',
    'Sign in to ART. This only proves you own this wallet. It does not move funds and gives ART no permission to spend them.',
    '',
    `URI: https://${domain}`,
    'Version: 1',
    'Chain ID: mainnet',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join('\n');
}

function consentMessage({ wallet, vault, mode, maxPositionSol, maxDailyLossPct, maxConcurrent, nonce, issuedAt }) {
  return [
    `ART trading consent (${CONSENT_VERSION})`,
    `Wallet: ${wallet}`,
    `Vault: ${vault}`,
    `Mode: ${mode}`,
    `Max per trade: ${maxPositionSol} SOL`,
    `Max daily loss: ${maxDailyLossPct} %`,
    `Max open trades: ${maxConcurrent}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
    '',
    `I allow ART's trading service to buy and sell Solana tokens from my ART vault (${vault}) inside these limits.`,
    `The vault can send funds only back to my wallet (${wallet}). I can pause, stop, or withdraw at any time.`,
    'Trading can lose money and ART does not promise any profit.',
  ].join('\n');
}

function withdrawMessage({ wallet, vault, amount, to, nonce, issuedAt }) {
  return [
    'ART withdrawal (v1)',
    `Wallet: ${wallet}`,
    `Vault: ${vault}`,
    `Send: ${amount}`,
    `To: ${to || wallet}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
    '',
    'Send funds from my ART vault to the address after "To:" above and nowhere else. I checked that address. Transfers on Solana cannot be reversed.',
  ].join('\n');
}

/** "Key: value" lines -> object (first occurrence wins). */
function fields(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(': ');
    if (i > 0 && !(line.slice(0, i) in out)) out[line.slice(0, i)] = line.slice(i + 2);
  }
  return out;
}

function parseConsent(text) {
  const f = fields(text);
  return {
    wallet: f['Wallet'], vault: f['Vault'], mode: f['Mode'],
    maxPositionSol: Number(String(f['Max per trade'] || '').replace(' SOL', '')),
    maxDailyLossPct: Number(String(f['Max daily loss'] || '').replace(' %', '')),
    maxConcurrent: Number(f['Max open trades']), nonce: f['Nonce'], issuedAt: f['Issued'],
  };
}

function parseWithdraw(text) {
  const f = fields(text);
  return { wallet: f['Wallet'], vault: f['Vault'], amount: f['Send'], to: f['To'], nonce: f['Nonce'], issuedAt: f['Issued'] };
}

function parseSignIn(text) {
  const lines = String(text).split('\n');
  const f = fields(text);
  return { domain: (lines[0] || '').replace(' wants you to sign in with your Solana account:', ''), wallet: lines[1], nonce: f['Nonce'], issuedAt: f['Issued At'], expiresAt: f['Expiration Time'] };
}

module.exports = { CONSENT_VERSION, signInMessage, consentMessage, withdrawMessage, parseConsent, parseWithdraw, parseSignIn };
