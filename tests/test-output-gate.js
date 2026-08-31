// Test for ADR-0001 — the Output Gate, the single owner of chain
// audibility (src/output-gate.js).
//
// This is the suite's first PURE STATE-MACHINE test: the module under
// test needs no AudioContext, no DOM, no rAF and no other src file — a
// recording AudioParam stub and a pair of fake timers are the whole
// harness. That is the point of the refactor being tested: precedence
// between the watchdog latch, Bypass and the rebuild duck used to be
// re-derived pairwise across three files and could only be exercised by
// standing up analysers, gains and a rAF queue; now it is a plain
// hold()/release() truth table.
//
// What this file proves:
//   1. Holds map to their fixed targets and per-reason ramp curves:
//      duck -> linear 15 ms to 0.0001; bypass -> linear 5 ms to 0;
//      watchdog -> setTargetAtTime 0 (mute tau) down, restore tau up.
//   2. Precedence is arbitration, not scheduling: releasing one hold
//      while another is active schedules NOTHING (no upward ramp can
//      ever race a latch), and holding a lower-precedence reason while
//      a higher one is active schedules nothing either.
//   3. Holds are a set: double-hold and double-release are no-ops.
//   4. Holds recorded BEFORE attach() are applied at attach.
//   5. The invariant check (defendMute's demoted successor) exists only
//      while a hold is active (setInterval on first hold / clearInterval
//      on last release) and re-asserts the mute only when the observed
//      gain RISES by more than the epsilon.
//   6. Misuse throws: unknown reasons, attaching a second gate.
//
// Run from a clean clone:  node tests/test-output-gate.js
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

// ----------------------------------------------------------------------
// Recording AudioParam stub. Every automation call is recorded with its
// method and arguments so each transition's CURVE is assertable, not just
// its final value. Mirrors the suite's house stub: setValueAtTime and
// linearRampToValueAtTime snap .value (a linear ramp reaches its target);
// setTargetAtTime does NOT (exponential — never actually arrives).
// ----------------------------------------------------------------------
function makeGateStub() {
  var events = [];
  return {
    gain: {
      value: 1,
      cancelScheduledValues: function (t) {
        events.push({ type: 'cancel', t: t });
      },
      setValueAtTime: function (v, t) {
        events.push({ type: 'setValue', target: v, t: t });
        this.value = v;
      },
      linearRampToValueAtTime: function (v, endT) {
        events.push({ type: 'linearRamp', target: v, endT: endT });
        this.value = v;
      },
      setTargetAtTime: function (v, t, tc) {
        events.push({ type: 'setTarget', target: v, t: t, tc: tc });
      }
    },
    __events: events
  };
}

/** Automation entries that represent a real TRANSITION (setValue merely
 *  pins the current value; cancel clears). */
function transitions(gate) {
  return gate.__events.filter(function (e) {
    return e.type === 'linearRamp' || e.type === 'setTarget';
  });
}

function lastTransition(gate) {
  var t = transitions(gate);
  return t.length ? t[t.length - 1] : null;
}

// ----------------------------------------------------------------------
// Sandbox: fake timers (recorded, manually fired) + the real src file.
// ----------------------------------------------------------------------
function createSandbox() {
  var intervals = []; // {id, fn, ms, cleared}
  var nextId = 1;
  var sandbox = {
    console: console,
    setInterval: function (fn, ms) {
      var id = nextId++;
      intervals.push({ id: id, fn: fn, ms: ms, cleared: false });
      return id;
    },
    clearInterval: function (id) {
      intervals.forEach(function (rec) {
        if (rec.id === id) {
          rec.cleared = true;
        }
      });
    }
  };
  sandbox.window = sandbox;
  sandbox.__intervals = intervals;
  vm.createContext(sandbox);
  var src = fs.readFileSync(path.join(ROOT, 'src', 'output-gate.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'src/output-gate.js' });
  return sandbox;
}

function liveIntervals(sandbox) {
  return sandbox.__intervals.filter(function (rec) {
    return !rec.cleared;
  });
}

var CTX = { currentTime: 10 };

// The published curve constants (asserted against, so a drift in either
// place fails loudly): duck 15 ms linear, bypass 5 ms linear, watchdog
// tau 0.02/3 down / 0.05/3 up.
var DUCK_S = 0.015;
var BYPASS_S = 0.005;
var MUTE_TC = 0.02 / 3;
var RESTORE_TC = 0.05 / 3;

async function main() {
  // ---------------------------------------------------------------- A
  console.log('A. attach + misuse contracts');
  {
    var sb = createSandbox();
    var OutputGate = sb.window.OutputGate;

    check(approx(OutputGate.DUCK_FADE_S, DUCK_S), 'A1: DUCK_FADE_S is published as 0.015');

    var threw = false;
    try {
      OutputGate.hold('solo');
    } catch (err) {
      threw = true;
    }
    check(threw, 'A2: hold() with an unknown reason throws');

    // Hold BEFORE attach: legal (Bypass can engage before the first
    // buildGraph creates the gate). Nothing to schedule yet...
    OutputGate.hold('bypass');
    check(OutputGate.isHeld('bypass'), 'A3: pre-attach hold is recorded');

    // ...and attach applies the effective target with the dominant
    // reason's down curve.
    var gate = makeGateStub();
    OutputGate.attach(gate, CTX);
    var last = lastTransition(gate);
    check(
      last !== null && last.type === 'linearRamp' && last.target === 0,
      'A4: attach() applies the pre-recorded hold (ramp to 0)'
    );

    var threw2 = false;
    try {
      OutputGate.attach(makeGateStub(), CTX);
    } catch (err2) {
      threw2 = true;
    }
    check(threw2, 'A5: attaching a DIFFERENT gate throws (one gate per session)');

    OutputGate.attach(gate, CTX); // same node again
    check(true, 'A6: re-attaching the SAME gate is a harmless no-op');
  }

  // ---------------------------------------------------------------- B
  console.log('B. per-reason targets and curves');
  {
    var sb2 = createSandbox();
    var OG = sb2.window.OutputGate;
    var g = makeGateStub();
    OG.attach(g, CTX);

    OG.hold('duck');
    var e1 = lastTransition(g);
    check(
      e1.type === 'linearRamp' && approx(e1.target, 0.0001) && approx(e1.endT, CTX.currentTime + DUCK_S),
      'B1: duck hold = 15 ms linear ramp to the 0.0001 duck floor'
    );

    OG.release('duck');
    var e2 = lastTransition(g);
    check(
      e2.type === 'linearRamp' && e2.target === 1 && approx(e2.endT, CTX.currentTime + DUCK_S),
      'B2: duck release = 15 ms linear ramp back to 1'
    );

    OG.hold('bypass');
    var e3 = lastTransition(g);
    check(
      e3.type === 'linearRamp' && e3.target === 0 && approx(e3.endT, CTX.currentTime + BYPASS_S),
      'B3: bypass hold = 5 ms linear ramp to 0'
    );

    OG.release('bypass');
    var e4 = lastTransition(g);
    check(
      e4.type === 'linearRamp' && e4.target === 1 && approx(e4.endT, CTX.currentTime + BYPASS_S),
      'B4: bypass release = 5 ms linear ramp back to 1'
    );

    OG.hold('watchdog');
    var e5 = lastTransition(g);
    check(
      e5.type === 'setTarget' && e5.target === 0 && approx(e5.tc, MUTE_TC),
      'B5: watchdog hold = setTargetAtTime 0 at the ~20 ms mute tau'
    );

    OG.release('watchdog');
    var e6 = lastTransition(g);
    check(
      e6.type === 'setTarget' && e6.target === 1 && approx(e6.tc, RESTORE_TC),
      'B6: watchdog release = setTargetAtTime 1 at the ~50 ms restore tau'
    );

    // Every transition above pinned the current value first (the house
    // click-safe triple): cancel, setValue(pin), then the ramp.
    var evs = g.__events;
    var tripleOk = true;
    for (var i = 0; i < evs.length; i++) {
      if (evs[i].type === 'linearRamp' || evs[i].type === 'setTarget') {
        tripleOk = tripleOk && evs[i - 1] && evs[i - 1].type === 'setValue' &&
          evs[i - 2] && evs[i - 2].type === 'cancel';
      }
    }
    check(tripleOk, 'B7: every ramp is preceded by cancel + pin (click-safe triple)');
  }

  // ---------------------------------------------------------------- C
  console.log('C. precedence: arbitration without scheduling');
  {
    var sb3 = createSandbox();
    var OG3 = sb3.window.OutputGate;
    var g3 = makeGateStub();
    OG3.attach(g3, CTX);

    OG3.hold('watchdog');
    g3.gain.value = 0; // emulate the setTarget decay (the stub never moves .value)
    OG3.hold('bypass');
    var count = transitions(g3).length;
    check(count === 1, 'C1: holding bypass under an active watchdog schedules nothing (already 0)');

    OG3.release('watchdog');
    check(
      transitions(g3).length === count,
      'C2: releasing the watchdog under an active bypass schedules NO upward ramp'
    );
    check(g3.gain.value < 0.001, 'C3: the gate is still silent (bypass hold stands)');

    OG3.hold('duck');
    check(
      transitions(g3).length === count,
      'C4: ducking a rebuild under an active bypass schedules nothing'
    );

    OG3.release('duck');
    OG3.release('bypass');
    var eUp = lastTransition(g3);
    check(
      eUp.type === 'linearRamp' && eUp.target === 1 && approx(eUp.endT, CTX.currentTime + BYPASS_S),
      'C5: the LAST release ramps up, using the releasing reason\'s own curve'
    );

    // Duck alone vs a trip landing mid-duck: the mute curve wins.
    OG3.hold('duck');
    OG3.hold('watchdog');
    var eMute = lastTransition(g3);
    check(
      eMute.type === 'setTarget' && eMute.target === 0 && approx(eMute.tc, MUTE_TC),
      'C6: a trip mid-duck re-schedules to hard 0 at watchdog mute speed'
    );
    OG3.release('duck');
    var afterDuckRelease = lastTransition(g3);
    check(
      afterDuckRelease === eMute,
      'C7: the rebuild\'s un-duck under a latch schedules nothing (the old issue-#3 race, now unrepresentable)'
    );
    OG3.release('watchdog');

    // Idempotence.
    var before = transitions(g3).length;
    OG3.hold('bypass');
    OG3.hold('bypass');
    check(transitions(g3).length === before + 1, 'C8: double-hold schedules exactly once (holds are a set)');
    OG3.release('bypass');
    OG3.release('bypass');
    check(transitions(g3).length === before + 2, 'C9: double-release schedules exactly once');

    check(OG3.isHeld() === false, 'C10: isHeld() reports no active holds at the end');
  }

  // ---------------------------------------------------------------- D
  console.log('D. the invariant check (defendMute, demoted)');
  {
    var sb4 = createSandbox();
    var OG4 = sb4.window.OutputGate;
    var g4 = makeGateStub();
    OG4.attach(g4, CTX);

    check(liveIntervals(sb4).length === 0, 'D1: no timer while nothing is held');

    OG4.hold('watchdog');
    var live = liveIntervals(sb4);
    check(live.length === 1 && live[0].ms === 250, 'D2: first hold arms one 250 ms interval');

    // Emulate the mute decay (the stub's setTarget never moves .value)
    // and let one quiet tick observe the settled 0 first — exactly the
    // cadence the real check sees.
    g4.gain.value = 0;
    live[0].fn();

    // Now a foreign/stale upward drift well past the epsilon: the mute
    // must be re-asserted at the dominant reason's down curve.
    var beforeD = transitions(g4).length;
    g4.gain.value = 0.9;
    live[0].fn();
    var eDefend = lastTransition(g4);
    check(
      transitions(g4).length === beforeD + 1 &&
        eDefend.type === 'setTarget' && eDefend.target === 0 && approx(eDefend.tc, MUTE_TC),
      'D3: an observed gain RISE re-asserts the mute (watchdog curve)'
    );

    // A small drift (below the 0.05 rise epsilon) must NOT re-fire —
    // the check may not fight its own in-flight ramp.
    var afterD = transitions(g4).length;
    g4.gain.value = 0.02;
    live[0].fn();
    g4.gain.value = 0.04; // rose, but by < epsilon
    live[0].fn();
    check(transitions(g4).length === afterD, 'D4: a sub-epsilon drift does not re-fire the mute');

    OG4.release('watchdog');
    check(liveIntervals(sb4).length === 0, 'D5: the last release disarms the timer');

    // Holding two reasons then releasing one keeps the timer alive.
    OG4.hold('bypass');
    OG4.hold('duck');
    OG4.release('duck');
    check(liveIntervals(sb4).length === 1, 'D6: the timer stays armed while any hold remains');
    OG4.release('bypass');
    check(liveIntervals(sb4).length === 0, 'D7: ...and disarms with the last of them');
  }

  console.log('');
  if (failures.length > 0) {
    console.log('FAILED: ' + failures.length + ' check(s):');
    failures.forEach(function (f) {
      console.log('  - ' + f);
    });
    process.exit(1);
  }
  console.log('PASS: all checks passed.');
  process.exit(0);
}

main().catch(function (err) {
  console.error('CRASH:', err);
  process.exit(1);
});
