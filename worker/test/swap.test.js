const test = require('node:test');
const assert = require('node:assert');
const { explainSim } = require('../src/trading/swap');

test('a doomed buy is explained in plain words', () => {
  assert.strictEqual(explainSim({ InstructionError: [2, { Custom: 1 }] }, ['Transfer: insufficient lamports 100, need 2000']).fatal, true);
  assert.match(explainSim({ InstructionError: [3, { Custom: 6002 }] }, []).why, /slippage/);
  assert.strictEqual(explainSim({ InstructionError: [3, { Custom: 6002 }] }, []).fatal, false);
  assert.match(explainSim({ InstructionError: [3, { Custom: 6005 }] }, []).why, /regular pool/);
});
