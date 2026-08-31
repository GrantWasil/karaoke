// Output Gate — the single owner of chain audibility (ADR-0001).
//
// Loaded as a plain (non-module) <script> — same IIFE + single `window.X`
// export pattern as the rest of this project — exposing one namespace,
// `window.OutputGate`.
//
// Why this file exists: the chain gate GainNode used to have three writers
// (audio-graph's rebuild duck, AudioBypass, the watchdog's mute), each with
// its own ramp idiom, each re-deriving precedence by querying the other two,
// plus a polling defendMute() loop to catch writers that got it wrong.
// This module replaces all of that with one rule: silence requests are
// HOLDS, and the chain is audible only while no hold is active.
//
// Interface:
//   attach(gateNode, audioContext) — one-time hand-over from AudioGraph,
//     which still CREATES and WIRES the node (topology stays AudioGraph's;
//     audibility is this module's). Holds requested before attach are
//     recorded and applied at attach.
//   hold(reason) / release(reason) — reason is 'watchdog' | 'bypass' |
//     'duck'. Idempotent per reason (holds are a set, not a count).
//   isHeld(reason?) — probe one reason, or (no arg) whether any hold is
//     active.
//   DUCK_FADE_S — read-only: the duck ramp length. audio-graph's deferred
//     rewire timer MUST wait at least this long, so the constant is shared,
//     not duplicated (surgery while audible would click).
//
// Precedence (watchdog > bypass > duck) is internal and only visible as
// the effective target: watchdog or bypass hold -> 0; duck alone ->
// DUCK_FLOOR (near-silence keeps the ramp exactly the shape the RQ-1
// research committed to); no holds -> 1. Releasing one hold while another
// is active therefore never schedules an upward ramp — this is what
// deletes the old pairwise isTripped()/isEngaged() checks at every writer.
//
// Ramp curves are per-reason IMPLEMENTATION, not interface (each has
// exactly one caller — deliberately NOT added to AudioParamRamp, whose
// contract is the fixed 15 ms node-param ramp):
//   watchdog: setTargetAtTime, tau MUTE_TC_S down / RESTORE_TC_S up (the
//     spec's ~20 ms mute, ~50 ms restore);
//   bypass:   5 ms linear both ways ("near-instant matters more than
//     smooth" — an emergency control);
//   duck:     15 ms linear both ways (the RQ-1 rebuild fade).
//
// The invariant check (the demoted successor of meter-taps' defendMute):
// while any hold is active, a self-armed 250 ms interval re-asserts the
// mute if the observed gain RISES anyway. With this module as the only
// writer that can no longer be a foreign module — it guards against Web
// Audio scheduling races (a stale ramp landing late), nothing else. The
// timer exists only while a hold is active; zero holds, zero timers.

(function () {
  'use strict';

  // Precedence order, highest first. Also the exhaustive list of valid
  // hold reasons — hold()/release() throw on anything else (misuse is a
  // programming error, same contract style as AudioGraph.buildGraph).
  var REASONS = ['watchdog', 'bypass', 'duck'];

  // Duck floor: near-silence, not 0 — the committed RQ-1 rebuild fade
  // shape (audio-graph has always ducked to 0.0001, ~-80 dB).
  var DUCK_FLOOR = 0.0001;
  var DUCK_FADE_S = 0.015; // 15 ms, per the committed RQ-1 research
  var BYPASS_RAMP_S = 0.005; // 5 ms — emergency-fast, still click-free

  // setTargetAtTime reaches ~95% of target at 3 time constants: these
  // give the watchdog spec's ~20 ms mute ramp and ~50 ms restore ramp.
  var MUTE_TC_S = 0.02 / 3;
  var RESTORE_TC_S = 0.05 / 3;

  // Invariant check: re-assert the mute only when the observed gain.value
  // RISES by more than this while a hold is active. Measuring the RISE,
  // not the absolute, keeps the check from fighting its own in-flight
  // ramp (a releasing setTarget curve still decaying, a duck mid-fade).
  var GAIN_RISE_EPS = 0.05;
  var VERIFY_INTERVAL_MS = 250;

  // ---------------------------------------------------------------------
  // Module state.
  // ---------------------------------------------------------------------

  var gate = null; // the chain gate GainNode, handed over via attach()
  var ctx = null; // its AudioContext (for currentTime)
  var active = { watchdog: false, bypass: false, duck: false };
  var lastSeenGain = 0; // gain as of the previous verify tick
  var verifyTimer = null;

  function assertReason(reason) {
    if (REASONS.indexOf(reason) === -1) {
      throw new Error(
        "OutputGate: unknown hold reason '" + reason + "' — must be one of " +
        REASONS.join(', ') + '.'
      );
    }
  }

  function anyHeld() {
    return active.watchdog || active.bypass || active.duck;
  }

  /** The gate's correct steady-state gain given the active holds. */
  function effectiveTarget() {
    if (active.watchdog || active.bypass) {
      return 0;
    }
    if (active.duck) {
      return DUCK_FLOOR;
    }
    return 1;
  }

  /** Highest-precedence active reason (only meaningful while anyHeld()). */
  function dominantReason() {
    for (var i = 0; i < REASONS.length; i++) {
      if (active[REASONS[i]]) {
        return REASONS[i];
      }
    }
    return null;
  }

  function nowTime() {
    return ctx && typeof ctx.currentTime === 'number' && isFinite(ctx.currentTime)
      ? ctx.currentTime
      : 0;
  }

  /** The house click-avoiding triple, linear form: cancel pending
   *  automation, pin at the current value, ramp linearly to target. */
  function scheduleLinear(target, seconds) {
    var t = nowTime();
    gate.gain.cancelScheduledValues(t);
    gate.gain.setValueAtTime(gate.gain.value, t);
    gate.gain.linearRampToValueAtTime(target, t + seconds);
  }

  /** The same triple, exponential form (setTargetAtTime) — the watchdog's
   *  curve shape. */
  function scheduleTarget(target, timeConstant) {
    var t = nowTime();
    gate.gain.cancelScheduledValues(t);
    gate.gain.setValueAtTime(gate.gain.value, t);
    gate.gain.setTargetAtTime(target, t, timeConstant);
  }

  /**
   * Schedule the gate toward `target` using `reason`'s curve for the
   * given direction ('down' = toward silence, 'up' = toward audible).
   * The acting reason picks the curve: a trip mutes at watchdog speed
   * even if a duck is also in flight; a restore rises at restore speed.
   */
  function applyCurve(reason, direction, target) {
    if (!gate) {
      return; // pre-attach — the hold is recorded; attach() applies it
    }
    if (reason === 'watchdog') {
      scheduleTarget(target, direction === 'down' ? MUTE_TC_S : RESTORE_TC_S);
    } else if (reason === 'bypass') {
      scheduleLinear(target, BYPASS_RAMP_S);
    } else {
      scheduleLinear(target, DUCK_FADE_S);
    }
    try {
      lastSeenGain = gate.gain.value;
    } catch (err) {
      lastSeenGain = 1;
    }
  }

  // ---------------------------------------------------------------------
  // The invariant check (self-armed; exists only while a hold is active).
  // ---------------------------------------------------------------------

  function verifyTick() {
    try {
      if (!gate || !anyHeld()) {
        return;
      }
      var v = gate.gain.value;
      if (v > GAIN_RISE_EPS && v > lastSeenGain + GAIN_RISE_EPS) {
        applyCurve(dominantReason(), 'down', effectiveTarget());
      }
      lastSeenGain = v;
    } catch (err) {
      // One-strike discipline (house precedent, src/meter-taps.js): a
      // wedged check must never spam the console forever. The holds and
      // the scheduled automation are untouched.
      stopVerifyTimer();
      console.error(
        'OutputGate: invariant check failed — check stopped; holds and scheduled ramps are unaffected.',
        err
      );
    }
  }

  function startVerifyTimer() {
    if (verifyTimer !== null || typeof setInterval !== 'function' || !gate) {
      return;
    }
    verifyTimer = setInterval(verifyTick, VERIFY_INTERVAL_MS);
  }

  function stopVerifyTimer() {
    if (verifyTimer !== null) {
      try {
        if (typeof clearInterval === 'function') {
          clearInterval(verifyTimer);
        }
      } catch (err) {
        /* nothing to clear */
      }
      verifyTimer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Public interface.
  // ---------------------------------------------------------------------

  /**
   * One-time hand-over from AudioGraph: the chain gate node and its
   * context. Applies the current effective target immediately (holds may
   * legally arrive before the gate exists — e.g. Bypass engaged before
   * the first buildGraph()). Re-attaching the same node is a no-op;
   * attaching a DIFFERENT node throws — one gate per session, by design.
   *
   * @param {GainNode} gateNode
   * @param {AudioContext} audioContext
   */
  function attach(gateNode, audioContext) {
    if (!gateNode || !gateNode.gain) {
      throw new Error('OutputGate.attach: gateNode must be a GainNode.');
    }
    if (gate && gate !== gateNode) {
      throw new Error('OutputGate.attach: a different gate is already attached.');
    }
    gate = gateNode;
    ctx = audioContext || ctx;
    try {
      lastSeenGain = gate.gain.value;
    } catch (err) {
      lastSeenGain = 1;
    }
    if (anyHeld()) {
      applyCurve(dominantReason(), 'down', effectiveTarget());
      startVerifyTimer();
    }
  }

  /**
   * Activate a hold. The gate ramps to the new effective target only when
   * the target actually changed — holding 'duck' while 'bypass' already
   * holds the gate at 0 schedules nothing (this is the precedence rule
   * doing its job; no caller ever needs to ask about the other reasons).
   *
   * @param {'watchdog'|'bypass'|'duck'} reason
   */
  function hold(reason) {
    assertReason(reason);
    if (active[reason]) {
      return;
    }
    var prev = effectiveTarget();
    active[reason] = true;
    var next = effectiveTarget();
    if (next !== prev) {
      applyCurve(reason, next < prev ? 'down' : 'up', next);
    }
    startVerifyTimer();
  }

  /**
   * Release a hold. Ramps upward only when no other hold remains — a
   * watchdog latch released while Bypass is engaged keeps the gate at 0
   * with no scheduling at all.
   *
   * @param {'watchdog'|'bypass'|'duck'} reason
   */
  function release(reason) {
    assertReason(reason);
    if (!active[reason]) {
      return;
    }
    var prev = effectiveTarget();
    active[reason] = false;
    var next = effectiveTarget();
    if (next !== prev) {
      applyCurve(reason, next < prev ? 'down' : 'up', next);
    }
    if (!anyHeld()) {
      stopVerifyTimer();
    }
  }

  /**
   * @param {string} [reason] - probe one reason; omit to ask whether ANY
   *   hold is active.
   * @returns {boolean}
   */
  function isHeld(reason) {
    if (reason === undefined) {
      return anyHeld();
    }
    assertReason(reason);
    return active[reason];
  }

  window.OutputGate = {
    attach: attach,
    hold: hold,
    release: release,
    isHeld: isHeld,
    // Read-only: audio-graph's deferred rewire timer derives its delay
    // from this so the surgery can never start before the duck lands.
    DUCK_FADE_S: DUCK_FADE_S,
  };
})();
