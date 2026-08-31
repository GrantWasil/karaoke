// Test for ADR-0002 — Chain Policy, the loudness policy engine
// (src/chain-policy.js).
//
// Like test-output-gate.js, this is a PURE test: the module under test is
// (model) -> value with no DOM, no Web Audio and no timers, so the whole
// harness is a bare vm sandbox. The agent-path integration (planners
// refusing on violations[0], clamps disclosed on toasts) stays covered by
// tests/test-safety-refusals.js and friends through the real tools; THIS
// file proves the policy engine itself, through the seam both actors now
// share:
//
//   1. checkChain() — every chain rule fires on a minimal violating
//      model and stays quiet on a conforming one.
//   2. budgetBreakdown() — the published 0.57 * |threshold| makeup
//      arithmetic, itemized.
//   3. applyPolicyToNodes() — the agent tier: clamp saturates and
//      discloses; reject aborts with the structured PARAM_OUT_OF_RANGE
//      result (budget attached for budget-feeding params).
//   4. The two-tier asymmetry is real: agent ranges are TIGHTER than the
//      human fader travel in the registry (ADR-0002 — human faders are
//      never clamped to agent ranges).
//   5. humanSummary() — the operator-facing one-liner for every rule id,
//      with the reason fallback.
//   6. Registry reads — the live NodeTypes registry wins; the snapshot
//      is the zero-dependency fallback.
//
// Run from a clean clone:  node tests/test-chain-policy.js
// Exits 0 on pass, 1 on any failure.

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');

var failures = [];

function check(cond, label) {
  if (cond) {
    console.log('  ok - ' + label);
  } else {
    failures.push(label);
    console.log('  FAIL - ' + label);
  }
}

function approx(a, b) {
  return Math.abs(a - b) < 1e-9;
}

function createSandbox() {
  var sandbox = { console: console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'src', 'chain-policy.js'), 'utf8'),
    sandbox,
    { filename: 'src/chain-policy.js' }
  );
  return sandbox;
}

/** Rule ids present in a checkChain() result. */
function ruleIds(violations) {
  return violations.map(function (v) { return v.rule_id; });
}

function has(violations, ruleId) {
  return ruleIds(violations).indexOf(ruleId) !== -1;
}

// A minimal conforming chain: one gain at 0 dB, terminal limiter at the
// factory ceiling. Budget: 0 + 0.57 * |-1| = 0.57 dB — far inside +12.
function conformingChain() {
  return [
    { id: 'n1', type: 'gain', params: { gainDb: 0 } },
    { id: 'n2', type: 'limiter', params: { ceiling: -6, release: 120 } }
  ];
}

function main() {
  var sb = createSandbox();
  var CP = sb.window.ChainPolicy;
  var LIM = CP.CHAIN_LIMITS;

  // ---------------------------------------------------------------- A
  console.log('A. checkChain — quiet on a conforming chain, loud per rule');

  check(CP.checkChain(conformingChain()).length === 0,
    'A1: a conforming chain produces zero violations');

  var empty = CP.checkChain([]);
  check(has(empty, 'limiter-required-terminal'),
    'A2: an empty chain violates limiter-required-terminal');

  var notLast = CP.checkChain([
    { id: 'n1', type: 'limiter', params: {} },
    { id: 'n2', type: 'gain', params: {} }
  ]);
  check(has(notLast, 'limiter-required-terminal'),
    'A3: a limiter that is not last violates limiter-required-terminal');

  var dup = CP.checkChain([
    { id: 'n1', type: 'limiter', params: {} },
    { id: 'n2', type: 'limiter', params: {} }
  ]);
  check(has(dup, 'limiter-required-terminal'),
    'A4: a duplicate limiter upstream violates limiter-required-terminal');

  var many = [];
  for (var i = 0; i < LIM.MAX_NODES; i++) {
    many.push({ id: 'g' + i, type: 'gain', params: { gainDb: 0 } });
  }
  many.push({ id: 'lim', type: 'limiter', params: {} });
  check(has(CP.checkChain(many), 'node-count-cap'),
    'A5: ' + (LIM.MAX_NODES + 1) + ' nodes violates node-count-cap');

  var gains = [];
  for (var g = 0; g <= LIM.MAX_GAIN_NODES; g++) {
    gains.push({ id: 'g' + g, type: 'gain', params: { gainDb: 0 } });
  }
  gains.push({ id: 'lim', type: 'limiter', params: {} });
  check(has(CP.checkChain(gains), 'gain-node-count'),
    'A6: ' + (LIM.MAX_GAIN_NODES + 1) + ' gain nodes violates gain-node-count');

  var comps = CP.checkChain([
    { id: 'c1', type: 'compressor', params: {} },
    { id: 'c2', type: 'compressor', params: { threshold: -8 } },
    { id: 'lim', type: 'limiter', params: {} }
  ]);
  check(has(comps, 'compressor-node-count'),
    'A7: compressor + compressor + limiter violates compressor-node-count (limiter counts)');

  var eqs = CP.checkChain([
    { id: 'e1', type: 'eq', params: {} },
    { id: 'e2', type: 'eq', params: {} },
    { id: 'e3', type: 'eq', params: {} },
    { id: 'lim', type: 'limiter', params: {} }
  ]);
  check(has(eqs, 'eq-max-bands'),
    'A8: three eq nodes (9 bands) violates eq-max-bands');

  var boostSum = CP.checkChain([
    { id: 'e1', type: 'eq', params: { lowGain: 5, midGain: 5, highGain: 5 } },
    { id: 'lim', type: 'limiter', params: {} }
  ]);
  check(has(boostSum, 'eq-boost-sum'),
    'A9: +15 dB of summed EQ boost violates eq-boost-sum');

  var bigBoosts = CP.checkChain([
    { id: 'e1', type: 'eq', params: { lowGain: 6, midGain: 6, highGain: -3 } },
    { id: 'lim', type: 'limiter', params: {} }
  ]);
  check(has(bigBoosts, 'eq-single-big-boost'),
    'A10: two bands at +6 dB violates eq-single-big-boost');

  var compound = CP.checkChain([
    { id: 'e1', type: 'eq', params: { lowGain: 4, midGain: 3, highGain: 0 } },
    { id: 'd1', type: 'delay', params: { feedback: 60 } },
    { id: 'lim', type: 'limiter', params: {} }
  ]);
  check(has(compound, 'compound-loop-guard'),
    'A11: feedback 60 % + boost sum +7 dB violates compound-loop-guard');

  var overBudget = CP.checkChain([
    { id: 'g1', type: 'gain', params: { gainDb: 10 } },
    { id: 'c1', type: 'compressor', params: { threshold: -24 } },
    { id: 'lim', type: 'limiter', params: { ceiling: -3 } }
  ]);
  check(has(overBudget, 'gain-budget-12db'),
    'A12: 10 + 0.57*24 + 0.57*3 = ~25.4 dB violates gain-budget-12db');

  var shape = overBudget.filter(function (v) { return v.rule_id === 'gain-budget-12db'; })[0];
  check(!!shape && shape.error === true && shape.applied === null &&
    typeof shape.rule_text === 'string' && typeof shape.suggestion === 'string' &&
    shape.budget && typeof shape.budget.estimatedDb === 'number',
    'A13: violations carry the structured shape (error/applied/rule_text/suggestion + rule fields)');

  // ---------------------------------------------------------------- B
  console.log('B. budgetBreakdown — the published makeup arithmetic');
  var budget = CP.budgetBreakdown([
    { id: 'g1', type: 'gain', params: { gainDb: 2 } },
    { id: 'c1', type: 'compressor', params: { threshold: -10 } },
    { id: 'lim', type: 'limiter', params: { ceiling: -6 } }
  ]);
  var want = 2 + 0.57 * 10 + 0.57 * 6; // 2 + 5.7 + 3.42 = 11.12
  check(approx(budget.estimatedDb, Math.round(want * 100) / 100),
    'B1: estimatedDb = gainDb + 0.57*|threshold| + 0.57*|ceiling| (' + budget.estimatedDb + ')');
  check(budget.limitDb === LIM.MAX_TOTAL_GAIN_DB &&
    approx(budget.remainingDb, Math.round((LIM.MAX_TOTAL_GAIN_DB - want) * 100) / 100),
    'B2: limit and remaining are derived from CHAIN_LIMITS, itemized');
  check(budget.components.length === 3,
    'B3: every contributing node appears in components[]');

  // ---------------------------------------------------------------- C
  console.log('C. applyPolicyToNodes — the agent tier');
  var clampRes = CP.applyPolicyToNodes([
    { id: 'c1', type: 'compressor', params: { ratio: 15 } }
  ]);
  check(clampRes.reject === null &&
    clampRes.nodes[0].params.ratio === CP.AGENT_PARAM_POLICY.compressor.ratio.max,
    'C1: an out-of-range clamp param saturates to the agent max');
  check(clampRes.clamped.length === 1 &&
    clampRes.clamped[0].requested === 15 &&
    clampRes.clamped[0].applied === CP.AGENT_PARAM_POLICY.compressor.ratio.max,
    'C2: the clamp is disclosed (requested vs applied)');

  var rejectRes = CP.applyPolicyToNodes([
    { id: 'g1', type: 'gain', params: { gainDb: 20 } }
  ]);
  check(!!rejectRes.reject && rejectRes.reject.code === 'PARAM_OUT_OF_RANGE' &&
    rejectRes.reject.applied === null,
    'C3: an out-of-range reject param aborts with PARAM_OUT_OF_RANGE, nothing applied');
  check(!!rejectRes.reject.budget && typeof rejectRes.reject.budget.remainingDb === 'number',
    'C4: a budget-feeding reject attaches the budget breakdown');

  var inRange = CP.applyPolicyToNodes([
    { id: 'd1', type: 'delay', params: { feedback: 40 } }
  ]);
  check(inRange.reject === null && inRange.clamped.length === 0 &&
    inRange.nodes[0].params.feedback === 40,
    'C5: in-range values pass through untouched (defaults filled in)');

  // ---------------------------------------------------------------- D
  console.log('D. the two tiers are asymmetric by design (ADR-0002)');
  var humanFeedback = CP.paramSpecsFor('delay').filter(function (s) { return s.id === 'feedback'; })[0];
  check(!!humanFeedback &&
    CP.AGENT_PARAM_POLICY.delay.feedback.max < humanFeedback.max,
    'D1: agent delay.feedback cap (' + CP.AGENT_PARAM_POLICY.delay.feedback.max +
    ') is TIGHTER than the human fader travel (' + humanFeedback.max + ')');
  var humanGain = CP.paramSpecsFor('gain').filter(function (s) { return s.id === 'gainDb'; })[0];
  check(!!humanGain && CP.AGENT_PARAM_POLICY.gain.gainDb.max < humanGain.max,
    'D2: agent gain.gainDb cap (' + CP.AGENT_PARAM_POLICY.gain.gainDb.max +
    ') is TIGHTER than the human fader travel (' + humanGain.max + ')');

  // ---------------------------------------------------------------- E
  console.log('E. humanSummary — the operator register');
  var mapped = ['limiter-required-terminal', 'gain-budget-12db', 'node-count-cap',
    'gain-node-count', 'compressor-node-count', 'eq-max-bands', 'eq-boost-sum',
    'eq-single-big-boost', 'compound-loop-guard'];
  var allMapped = mapped.every(function (id) {
    var line = CP.humanSummary({ rule_id: id, reason: 'x' });
    return typeof line === 'string' && line.length > 0 && line !== 'x' && line.length < 80;
  });
  check(allMapped, 'E1: every checkChain-emitted rule id has a short operator line (< 80 chars)');
  check(CP.humanSummary({ rule_id: 'some-future-rule', reason: 'the long agent reason' }) ===
    'the long agent reason',
    'E2: unknown rule ids fall back to the violation reason');

  // ---------------------------------------------------------------- F
  console.log('F. registry reads — live wins, snapshot falls back');
  check(CP.paramSpecsFor('gain').length === 1 &&
    CP.paramSpecsFor('gain')[0].id === 'gainDb',
    'F1: with no NodeTypes loaded, the snapshot answers');
  sb.window.NodeTypes = {
    getAllTypes: function () { return ['gain']; },
    getParamSpec: function (type) {
      return type === 'gain'
        ? [{ id: 'gainDb', unit: 'dB', min: -24, max: 24, default: 0, extra: 'live' }]
        : [];
    }
  };
  check(CP.paramSpecsFor('gain')[0].extra === 'live',
    'F2: a populated live registry wins over the snapshot');
  check(CP.registryTypes().length === 1 && CP.registryTypes()[0] === 'gain',
    'F3: registryTypes() follows the live registry too');
  delete sb.window.NodeTypes;

  console.log('');
  if (failures.length > 0) {
    console.log('FAILED: ' + failures.length + ' check(s):');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
  console.log('PASS: all checks passed.');
  process.exit(0);
}

main();
