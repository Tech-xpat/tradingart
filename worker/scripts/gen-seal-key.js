// Run ONCE. Put VAULT_SEAL_SECRET in the worker env ONLY. Put VAULT_SEAL_PUBLIC in the web env.
// Losing VAULT_SEAL_SECRET means losing access to every vault. Back it up offline.
const { newSealKeypair } = require('../src/vault/seal');
const k = newSealKeypair();
console.log(`VAULT_SEAL_PUBLIC=${k.publicKey}   # web app (safe to share with the web host)`);
console.log(`VAULT_SEAL_SECRET=${k.secretKey}   # worker ONLY. Never commit. Back it up offline.`);
