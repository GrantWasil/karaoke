// Chain Policy — the loudness policy engine (ADR-0002).
//
// Loaded as a plain (non-module) <script> — same IIFE + single `window.X`
// export pattern as the rest of this project — exposing one namespace,
// `window.ChainPolicy`.
//
// Why this file exists: every rule about what a chain may look like and
// how loud it may get (rq3-loudness-policy.md, translated into app units)
// used to live inside src/mcp-tools.js, so it was enforced on the AGENT
// path only — the operator could drag a node past the limiter or bust the
// +12 dB budget and nothing objected. Extracted here, BOTH actors evaluate
// the same policy (CONTEXT.md: Chain Policy), asymmetrically per ADR-0002:
//
//   Universal tier — "chain rules": structural and loudness rules that
//   apply to any chain regardless of who built it. checkChain(model)
//   returns ALL violations (possibly []). Agent planners (mcp-tools)
//   refuse on the first; human paths (canvas drag/reorder, preset loads,
//   fader moves) WARN with humanSummary() and let the edit stand — the
//   show comes first, and Bypass remains the real safety net.
//
//   Agent tier — "agent param policy": per-param ranges deliberately
//   TIGHTER than the human fader travel (the agent gets a safety margin;
//   the human keeps full range). applyPolicyToNodes / policyFor /
//   hostOwnedFor apply to agent mutations only — nothing here ever clamps
//   a human fader.
//
// Pure by construction: everything below is (model) -> value with no DOM,
// no Web Audio, no timers. The only window read is the live NodeTypes
// registry (paramSpecsFor), with the static snapshot as the zero-
// dependency fallback — unifying those two registries is a recorded
// follow-up, deliberately out of this file's scope.
//
// Violation objects are the same structured results the agent tools
// return (error/code/rule_id/reason/rule_text/suggestion + rule-specific
// fields) — one shape, two consumers.

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Node-type registry snapshot — mirrors src/node-*.js verbatim.
  //
  // One entry per param: { id, unit, min, max, default } — the
  // paramSpec fields validation and get_capabilities' static fallback
  // need (label/step stay UI-only and are not mirrored; get_capabilities
  // falls back to TYPE_INFO's labels instead).
  // Sources, in index.html script order:
  //   gain       <- src/node-gain.js        (gainDb)
  //   compressor <- src/node-compressor.js  (threshold, ratio, attack,
  //                                          release)
  //   eq         <- src/node-eq.js          (lowGain, midGain, highGain)
  //   delay      <- src/node-delay.js       (timeMs, feedback, mix)
  //   reverb     <- src/node-reverb.js      (mix)
  //   limiter    <- src/node-limiter.js     (ceiling, release)
  // Ranges here are the app's OWN nominal slider ranges — NOT RQ-3's
  // tighter agent ranges (those are AGENT_PARAM_POLICY below and MC-4's
  // enforcement; e.g. delay feedback's nominal max is 90, RQ-3's agent
  // cap is 70).
  // ---------------------------------------------------------------------
  var NODE_REGISTRY_SNAPSHOT = {
    gain: [
      { id: 'gainDb', unit: 'dB', min: -24, max: 24, default: 0 }
    ],
    compressor: [
      { id: 'threshold', unit: 'dB', min: -60, max: 0, default: -24 },
      { id: 'ratio', unit: ':1', min: 1, max: 20, default: 4 },
      { id: 'attack', unit: 's', min: 0, max: 1, default: 0.01 },
      { id: 'release', unit: 's', min: 0, max: 1, default: 0.25 }
    ],
    eq: [
      { id: 'lowGain', unit: 'dB', min: -12, max: 12, default: 0 },
      { id: 'midGain', unit: 'dB', min: -12, max: 12, default: 0 },
      { id: 'highGain', unit: 'dB', min: -12, max: 12, default: 0 }
    ],
    delay: [
      { id: 'timeMs', unit: 'ms', min: 10, max: 1000, default: 300 },
      { id: 'feedback', unit: '%', min: 0, max: 90, default: 25 },
      { id: 'mix', unit: '%', min: 0, max: 100, default: 25 }
    ],
    reverb: [
      { id: 'mix', unit: '%', min: 0, max: 100, default: 20 }
    ],
    limiter: [
      { id: 'ceiling', unit: 'dB', min: -12, max: 0, default: -1 },
      { id: 'release', unit: 'ms', min: 10, max: 500, default: 50 }
    ]
  };

  // ---------------------------------------------------------------------
  // Registry resolution — live window.NodeTypes wins, snapshot falls back.
  // ---------------------------------------------------------------------

  /**
   * @returns {Array<string>} registered node-type names, in registration
   *   order. window.NodeTypes.getAllTypes() when it is populated; the
   *   static snapshot otherwise (empty live registry = node files not
   *   loaded, e.g. a bare test harness).
   */
  function registryTypes() {
    if (window.NodeTypes && typeof window.NodeTypes.getAllTypes === 'function') {
      var live = window.NodeTypes.getAllTypes();
      if (live && live.length > 0) {
        return live.slice();
      }
    }
    return Object.keys(NODE_REGISTRY_SNAPSHOT);
  }

  /**
   * @param {string} type - a node-type name.
   * @returns {Array<Object>} that type's param specs ({id, unit, min, max
   *   shaped}; live paramSpec entries carry extra UI fields, unused
   *   here). Empty array when the type is unknown.
   */
  function paramSpecsFor(type) {
    if (window.NodeTypes && typeof window.NodeTypes.getParamSpec === 'function') {
      var live = window.NodeTypes.getParamSpec(type);
      if (live && live.length > 0) {
        return live;
      }
    }
    var snap = NODE_REGISTRY_SNAPSHOT[type];
    return snap ? snap : [];
  }

  // ---------------------------------------------------------------------
  // MC-3 policy block — RQ-3 (docs/ultron/research/rq3-loudness-policy.md,
  // the committed implementation source) translated into the APP's actual
  // param units. rq3 speaks Web-Audio-native units (linear gain, seconds,
  // 0..1 send gains); this app's params are host-facing units (dB, %, ms,
  // s). Every conversion, verified against the node files' real
  // semantics:
  //
  //   gain.gainDb      rq3 linear [0, 4.0] (direct-path, no negatives)
  //                    -> dB [-24, +12]: 20*log10(4.0) = +12.04 dB ~= +12;
  //                    negative linear gain is NOT expressible in dB
  //                    (src/node-gain.js writes 10^(dB/20), always
  //                    positive), so rq3's "no negatives" holds by
  //                    construction. Values above the agent max reject.
  //   compressor.*     rq3's comp rows are already dB / ratio / seconds
  //                    and src/node-compressor.js writes them straight
  //                    onto the AudioParams — identical numbers, no
  //                    conversion. (rq3's knee row has no app param: the
  //                    knee is deliberately fixed at the Web Audio
  //                    default 30 dB soft knee, per that file's own
  //                    comment.)
  //   eq.*Gain         rq3's EQ gain row is already dB. Cuts: rq3 clamps
  //                    to [-24, 0]; the app's own nominal floor (-12 dB)
  //                    is tighter and wins. Boosts: above +9 dB reject.
  //                    rq3's EQ frequency/Q clamps have no app params —
  //                    src/node-eq.js fixes them (200 Hz low shelf,
  //                    1 kHz peaking Q 1.0, 5 kHz high shelf), all
  //                    inside rq3's clamp ranges.
  //   delay.timeMs     rq3 delayTime [0.02, 0.75] s -> ms [20, 750]
  //                    (src/node-delay.js: delayTime.value = timeMs/1000;
  //                    createDelay(1.0) so the nominal 1000 ms max fits).
  //   delay.feedback   rq3 feedback gain [0, 0.70] linear (node hard-cap
  //                    0.85) -> % [0, 70]: src/node-delay.js writes
  //                    feedbackGain.gain.value = Math.min(feedback, 90)
  //                    /100, so linear = percent/100 and 0.70 linear =
  //                    70 on this param. NOTE: this app's own defensive
  //                    node hard-cap is 90 (0.90 linear), NOT rq3's
  //                    parenthetical 0.85 — the AGENT rule is unchanged
  //                    (0.70 linear = 70, reject above); only the
  //                    disclosed node ceiling differs.
  //   delay.mix /     rq3 bounds each wet/dry gain to [0, 1] with
  //   reverb.mix      wet+dry <= 1.5 (delay) and summed sends <= 1.2
  //                    (reverb). The app's mix is an EQUAL-POWER
  //                    crossfade (dry = cos(m*PI/2), wet = sin(m*PI/2),
  //                    m = mix/100 — src/node-delay.js and
  //                    src/node-reverb.js): each side stays in [0, 1],
  //                    wet+dry peaks at sqrt(2) ~= 1.414 < 1.5 for every
  //                    mix value, and the single reverb send never
  //                    exceeds 1.0 < 1.2 — all three bounds hold
  //                    structurally, so the agent range is the full
  //                    nominal 0-100 % (clamped).
  //   limiter.ceiling rq3 limiter threshold [-12, -3] dB -> same dB
  //                    (src/node-limiter.js writes ceiling straight onto
  //                    .threshold).
  //   limiter.release rq3 [0.05, 0.3] s -> ms [50, 300]
  //                    (src/node-limiter.js: release.value = value/1000).
  //
  // Makeup-gain estimate for the +12 dB budget rule (stated plainly so
  // agents can self-check): estimated makeup dB ~= 0.57 * |threshold| dB
  // — rq3's hard-knee anchors (threshold -12/ratio 20 => ~= +6.8 dB;
  // threshold -24 => ~= +13.7 dB) both sit on that line. Browser-
  // dependent by a few dB (the soft-knee curve is the UA's choice).
  // MC-4's enforcement uses the same constant.
  // ---------------------------------------------------------------------

  var MAKEUP_DB_PER_THRESHOLD_DB = 0.57;

  // ---------------------------------------------------------------------
  // MC-4 statics — the MACHINE-READABLE half of the rq3 policy. Everything
  // the enforcement engine below compares against comes from THIS block
  // (plus AGENT_PARAM_POLICY above and NODE_REGISTRY_SNAPSHOT): no rq3
  // numeric literal is ever re-typed in the enforcement code, so the
  // disclosure (CHAIN_RULES prose, get_capabilities) and the enforcement
  // cannot drift apart silently. If a number here must change, change the
  // matching CHAIN_RULES prose entry in the same edit — they are two views
  // of one table (rq3-loudness-policy.md).
  // ---------------------------------------------------------------------

  /**
   * Chain-level rq3 limits, keyed by the CHAIN_RULES id each enforces.
   * Per-param limits live in AGENT_PARAM_POLICY (min/max per param); the
   * makeup estimate lives in MAKEUP_DB_PER_THRESHOLD_DB. EQ band count
   * per eq node is DERIVED from the registry (paramSpecsFor('eq').length)
   * rather than restated here.
   */
  var CHAIN_LIMITS = {
    MAX_TOTAL_GAIN_DB: 12,         // gain-budget-12db
    MAX_GAIN_NODES: 6,             // gain-node-count
    MAX_COMPRESSOR_NODES: 2,       // compressor-node-count (compressor + limiter)
    MAX_NODES: 16,                 // node-count-cap
    MAX_EQ_BANDS: 6,               // eq-max-bands
    EQ_BOOST_SUM_MAX_DB: 12,       // eq-boost-sum
    EQ_SINGLE_BOOST_FLOOR_DB: 6,   // eq-single-big-boost (at most one band >= this)
    COMPOUND_FEEDBACK_MIN_PCT: 55, // compound-loop-guard (0.55 linear)
    COMPOUND_BOOST_SUM_MIN_DB: 6   // compound-loop-guard
  };

  /**
   * Params and elements that are HOST-OWNED per rq3 — not addressable by
   * any tool; writes are structurally rejected (code 'HOST_OWNED') with
   * the CHAIN_RULES id that discloses the ownership. Names here are
   * deliberately NOT in any paramSpec, so they reach this map only via
   * the host-owned carve-outs in validateParamsForType()/validateSetParam
   * (which let them past the unknown-param check so the rejection can
   * name the owning rule instead of a bare unknown-param error).
   */
  var HOST_OWNED_PARAMS = {
    limiter: {
      ratio: 'host-limiter-locks',
      attack: 'host-limiter-locks',
      knee: 'host-limiter-locks',
      reduction: 'host-limiter-locks'
    },
    reverb: {
      normalize: 'host-reverb-internals',
      buffer: 'host-reverb-internals'
    }
  };

  /**
   * RQ-3 agent ranges translated into app units (see the conversion
   * table above). Fields per param: { min, max, unit, treatment } where
   * treatment is 'reject' (out-of-range request -> structured error,
   * nothing applied) or 'clamp' (saturate to the range and disclose).
   * The `description` on each entry states the unit semantics and the
   * conversion so the agent can sanity-check its own numbers.
   */
  var AGENT_PARAM_POLICY = {
    gain: {
      gainDb: {
        min: -24, max: 12, unit: 'dB', treatment: 'reject',
        description:
          'Direct-path gain in dB (written as 10^(dB/20) linear). rq3 agent range is linear [0, 4.0] = up to 20*log10(4) = +12.04 dB with no negative linear gain — in this app\'s dB unit that is [-24, +12] (the app nominal floor; negative linear gain is not expressible in dB). Above +12 dB is rejected, and the value counts toward the +12 dB total budget including estimated makeup.'
      }
    },
    compressor: {
      threshold: {
        min: -40, max: -8, unit: 'dB', treatment: 'reject',
        description:
          'Level where compression starts, in dB (same unit rq3 uses — written straight onto the AudioParam). Out-of-range values are rejected. Estimated makeup of 0.57 * |threshold| counts toward the +12 dB budget.'
      },
      ratio: {
        min: 1.5, max: 12, unit: ':1', treatment: 'clamp',
        description:
          'Compression ratio (unitless N:1, written straight through). Out-of-range values are clamped into [1.5, 12].'
      },
      attack: {
        min: 0.001, max: 0.1, unit: 's', treatment: 'clamp',
        description:
          'Ramp-in time in SECONDS (rq3 range unchanged — the app param is already in s). Clamped into [0.001, 0.1] s (1-100 ms).'
      },
      release: {
        min: 0.02, max: 0.5, unit: 's', treatment: 'clamp',
        description:
          'Recovery time in SECONDS. Clamped into [0.02, 0.5] s (20-500 ms).'
      }
    },
    eq: {
      lowGain: {
        min: -12, max: 9, unit: 'dB', treatment: 'reject',
        description:
          'Low shelf (fixed 200 Hz) gain in dB. rq3 treatment for band gains: cuts clamp (into the app nominal [-12, 0]), boosts above +9 dB are REJECTED; boosts count toward the +12 dB boost-sum cap and the one-band->=+6 rule.'
      },
      midGain: {
        min: -12, max: 9, unit: 'dB', treatment: 'reject',
        description:
          'Peaking band (fixed 1 kHz, Q 1.0) gain in dB. Same policy: cuts clamp, boost above +9 dB rejects, boost sum <= +12 dB, at most one band >= +6 dB.'
      },
      highGain: {
        min: -12, max: 9, unit: 'dB', treatment: 'reject',
        description:
          'High shelf (fixed 5 kHz) gain in dB. Same policy: cuts clamp, boost above +9 dB rejects, boost sum <= +12 dB, at most one band >= +6 dB.'
      }
    },
    delay: {
      timeMs: {
        min: 20, max: 750, unit: 'ms', treatment: 'clamp',
        description:
          'Delay time in MILLISECONDS (DelayNode.delayTime is seconds; the app divides by 1000). rq3 agent range [0.02, 0.75] s = 20-750 ms; out-of-range values are clamped.'
      },
      feedback: {
        min: 0, max: 70, unit: '%', treatment: 'reject',
        description:
          'Feedback in PERCENT of each repeat re-fed into the delay (linear gain = feedback/100). rq3 caps the linear feedback gain at 0.70 — i.e. 70 on this param — and values above are REJECTED. The compound-loop guard additionally rejects feedback >= 55 whenever the EQ boost sum is >= +6 dB. (The node\'s own defensive hard cap is 90.)'
      },
      mix: {
        min: 0, max: 100, unit: '%', treatment: 'clamp',
        description:
          "Equal-power dry/wet crossfade in PERCENT (dry = cos, wet = sin of mix/100 * PI/2). Each side stays within [0, 1] and wet+dry peaks at ~1.414, inside rq3's 1.5 bound for every value — the nominal 0-100 % range applies, clamped."
      }
    },
    reverb: {
      mix: {
        min: 0, max: 100, unit: '%', treatment: 'clamp',
        description:
          "Equal-power dry/wet crossfade in PERCENT, same construction as delay's mix. The single reverb send never exceeds 1.0, so rq3's summed-sends bound of 1.2 holds structurally; nominal 0-100 % applies, clamped."
      }
    },
    limiter: {
      ceiling: {
        min: -12, max: -3, unit: 'dB', treatment: 'reject',
        description:
          "Output ceiling in dB (written straight onto the limiter's threshold). rq3 agent range [-12, -3] dB, enforced by rejection. Its estimated makeup (0.57 * |ceiling|) counts toward the +12 dB budget."
      },
      release: {
        min: 50, max: 300, unit: 'ms', treatment: 'clamp',
        description:
          'Release in MILLISECONDS (the AudioParam is seconds; the app divides by 1000). rq3 agent range [0.05, 0.3] s = 50-300 ms; out-of-range values are clamped.'
      }
    }
  };

  /**
   * Every rq3 chain rule, stated as get_capabilities publishes it.
   * { id, rule, enforcement } — the rule text carries the rq3 numbers
   * verbatim-in-substance, including the app-unit translations and the
   * host-owned disclosures (attenuator, reverb internals, limiter
   * locks).
   */
  var CHAIN_RULES = [
    {
      id: 'limiter-required-terminal',
      rule: 'A limiter node is REQUIRED and must be TERMINAL — the last node in the chain, MIC IN to OUT. The agent may only add nodes upstream of it; removing it, bypassing it, reordering it away from the end, or positioning any node after it is rejected.',
      enforcement: 'hard reject (nothing applied)'
    },
    {
      id: 'gain-budget-12db',
      rule: 'Total direct-path gain budget is +12 dB, INCLUDING estimated compressor/limiter makeup gain. Self-check formula: sum of every gain node\'s gainDb, plus 0.57 * |threshold| for each compressor, plus 0.57 * |ceiling| for the limiter, must be <= +12 dB. (rq3 anchors for the estimate, hard-knee bound: threshold -12/ratio 20 => ~= +6.8 dB; threshold -24 => ~= +13.7 dB; browser-dependent by a few dB.)',
      enforcement: 'reject (nothing applied)'
    },
    {
      id: 'negative-gain-rejected',
      rule: 'Negative linear gain (polarity inversion) is rejected. This app enters gain in dB and writes 10^(dB/20), which is always positive — the rule holds structurally, so there is no way to request it.',
      enforcement: 'reject; structurally unreachable in this app'
    },
    {
      id: 'eq-max-bands',
      rule: 'At most 6 EQ bands total. This app\'s eq node has 3 fixed bands (low/mid/high), so that means at most 2 eq nodes.',
      enforcement: 'reject'
    },
    {
      id: 'eq-boost-per-band',
      rule: 'Per-band EQ boost is capped at +9 dB; requests above +9 dB are rejected. Cuts are clamped into the app nominal [-12, 0] dB (rq3\'s -24 dB cut bound is looser than the app\'s own slider floor).',
      enforcement: 'boost above +9 dB: reject; cuts: clamp'
    },
    {
      id: 'eq-boost-sum',
      rule: 'The sum of all EQ band boosts must stay <= +12 dB.',
      enforcement: 'reject'
    },
    {
      id: 'eq-single-big-boost',
      rule: 'At most ONE EQ band may have a boost >= +6 dB.',
      enforcement: 'reject'
    },
    {
      id: 'delay-feedback-cap',
      rule: 'Delay feedback must stay <= 0.70 linear, which is 70 on the app\'s feedback param (percent; linear = feedback/100). Values above 70 are rejected. (The node\'s own defensive hard cap is 90 = 0.90 linear.)',
      enforcement: 'reject above 70'
    },
    {
      id: 'compound-loop-guard',
      rule: 'Compound-loop guard: delay feedback >= 0.55 linear (55 on the app\'s feedback percent param) AND EQ boost sum >= +6 dB together are rejected — high loop gain plus spectral lift is how ringback starts.',
      enforcement: 'reject when both conditions hold'
    },
    {
      id: 'mix-gain-bounds',
      rule: 'rq3 bounds delay wet+dry to <= 1.5 with each mix gain in [0, 1], and reverb sends to a summed <= 1.2. The app\'s equal-power crossfades satisfy all of these structurally (each side in [0, 1]; wet+dry peaks at sqrt(2) ~= 1.414; the single reverb send never exceeds 1.0), so the only enforced bound is the nominal 0-100 % clamp on the mix params.',
      enforcement: 'clamp to nominal 0-100 %; rq3 bounds hold by construction'
    },
    {
      id: 'gain-node-count',
      rule: 'At most 6 gain-type nodes. The param that counts: every gain node\'s gainDb (direct-path gain). Delay/reverb feedback and mix gains are send-path — governed by their own caps, not this count.',
      enforcement: 'reject'
    },
    {
      id: 'compressor-node-count',
      rule: "At most 2 compressor-type nodes total. Both DynamicsCompressorNode-based types count — 'compressor' and the required terminal 'limiter' — so at most one 'compressor' node beyond the limiter. Each adds fixed ~6 ms look-ahead latency (disclosed here).",
      enforcement: 'reject'
    },
    {
      id: 'node-count-cap',
      rule: 'The whole chain is capped at 16 nodes (all types, including the required limiter).',
      enforcement: 'reject'
    },
    {
      id: 'host-param-ramps',
      rule: 'The host ramps every param change over 10-20 ms — no instantaneous jumps, so edits never click.',
      enforcement: 'host behavior (disclosure)'
    },
    {
      id: 'host-output-attenuator',
      rule: 'A host-owned output attenuator (persistent GainNode after the limiter) is ALWAYS on and is NOT a param: default ceiling -6 dBFS, absolute never-exceed -3 dBFS. No tool can address it.',
      enforcement: 'host-owned; not addressable by any tool'
    },
    {
      id: 'host-reverb-internals',
      rule: 'The reverb\'s normalize flag and impulse-response buffer are host-owned; writes are rejected (they are not exposed as params at all).',
      enforcement: 'host-owned; writes rejected'
    },
    {
      id: 'host-limiter-locks',
      rule: 'The limiter\'s ratio is locked at 20:1 and its attack is locked (rq3 policy: 1-3 ms; this app fixes 0 ms — the node\'s native minimum, i.e. even faster), plus a locked 0 dB hard knee. None are addressable params.',
      enforcement: 'host-owned; writes rejected'
    },
    {
      id: 'error-shape',
      rule: 'Validation errors carry the requested value, the allowed range, what was applied (nothing, for rejects), and the remaining budget numbers for cumulative constraints — so a rejected call can be corrected in one step.',
      enforcement: 'host behavior (disclosure)'
    }
  ];

  /**
   * @param {string} type
   * @param {string} param
   * @returns {string|null} the CHAIN_RULES id owning this host-owned
   *   param, or null when the param is not host-owned.
   */
  function hostOwnedFor(type, param) {
    var owned = HOST_OWNED_PARAMS[type];
    return owned && Object.prototype.hasOwnProperty.call(owned, param)
      ? owned[param]
      : null;
  }

  /**
   * @param {string} type
   * @param {string} param
   * @returns {Object|null} the AGENT_PARAM_POLICY entry, or null.
   */
  function policyFor(type, param) {
    var perType = AGENT_PARAM_POLICY[type];
    return (perType && Object.prototype.hasOwnProperty.call(perType, param))
      ? perType[param]
      : null;
  }

  /**
   * The rule_id reported for a per-param policy decision: the CHAIN_RULES
   * id when a named rule covers the param, else the dotted policy
   * location ('gain.gainDb') — always a stable, greppable string.
   *
   * @param {string} type
   * @param {string} param
   * @returns {string}
   */
  function paramRuleId(type, param) {
    if (type === 'delay' && param === 'feedback') {
      return 'delay-feedback-cap';
    }
    if (type === 'eq' && /Gain$/.test(param)) {
      return 'eq-boost-per-band';
    }
    return type + '.' + param;
  }

  /**
   * @param {string} id - a CHAIN_RULES id.
   * @returns {Object|null} the rule entry, or null (unknown id).
   */
  function ruleById(id) {
    for (var i = 0; i < CHAIN_RULES.length; i++) {
      if (CHAIN_RULES[i].id === id) {
        return CHAIN_RULES[i];
      }
    }
    return null;
  }

  /**
   * @param {number} x
   * @returns {number} x rounded to 2 decimals (display-only; comparisons
   *   always use the unrounded values).
   */
  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  /**
   * A node entry's EFFECTIVE params: registered defaults overlaid with
   * the finite numbers actually stored. Model entries may legitimately
   * carry partial params (a preset node with only overrides), and every
   * cumulative rule (budget, boost sums) must reason about the value the
   * chain will really run with, not the sparse stored object.
   *
   * @param {{id: string, type: string, params?: Object}} entry
   * @returns {Object} fresh params object, fully populated.
   */
  function effectiveParamsFor(entry) {
    var params = {};
    paramSpecsFor(entry.type).forEach(function (spec) {
      params[spec.id] = spec.default;
    });
    var provided = entry.params || {};
    Object.keys(provided).forEach(function (key) {
      if (typeof provided[key] === 'number' && isFinite(provided[key])) {
        params[key] = provided[key];
      }
    });
    return params;
  }

  /**
   * rq3's +12 dB total direct-path gain budget, itemized: every gain
   * node's gainDb plus the estimated makeup (MAKEUP_DB_PER_THRESHOLD_DB *
   * |threshold/ceiling|) for each compressor-type node, per the
   * gain-budget-12db rule's published self-check formula.
   *
   * @param {Array<Object>} model - candidate entries (params may be
   *   partial; effective values are used).
   * @returns {{limitDb: number, estimatedDb: number, remainingDb: number, components: Array<Object>}}
   */
  function budgetBreakdown(model) {
    var components = [];
    var total = 0;
    model.forEach(function (entry) {
      var eff = effectiveParamsFor(entry);
      if (entry.type === 'gain' && typeof eff.gainDb === 'number') {
        total += eff.gainDb;
        components.push({
          node: entry.id, type: 'gain', param: 'gainDb',
          contributionDb: round2(eff.gainDb), detail: 'direct-path gain'
        });
      } else if (entry.type === 'compressor' && typeof eff.threshold === 'number') {
        var makeup = MAKEUP_DB_PER_THRESHOLD_DB * Math.abs(eff.threshold);
        total += makeup;
        components.push({
          node: entry.id, type: 'compressor', param: 'threshold',
          contributionDb: round2(makeup),
          detail: 'estimated makeup ' + MAKEUP_DB_PER_THRESHOLD_DB +
            ' * |threshold ' + eff.threshold + ' dB|'
        });
      } else if (entry.type === 'limiter' && typeof eff.ceiling === 'number') {
        var limiterMakeup = MAKEUP_DB_PER_THRESHOLD_DB * Math.abs(eff.ceiling);
        total += limiterMakeup;
        components.push({
          node: entry.id, type: 'limiter', param: 'ceiling',
          contributionDb: round2(limiterMakeup),
          detail: 'estimated makeup ' + MAKEUP_DB_PER_THRESHOLD_DB +
            ' * |ceiling ' + eff.ceiling + ' dB|'
        });
      }
    });
    return {
      limitDb: CHAIN_LIMITS.MAX_TOTAL_GAIN_DB,
      estimatedDb: round2(total),
      remainingDb: round2(CHAIN_LIMITS.MAX_TOTAL_GAIN_DB - total),
      components: components
    };
  }

  /**
   * Shared builder for chain-rule violation results (code = the rule id).
   *
   * @param {string} ruleId - a CHAIN_RULES id.
   * @param {Object} fields - extra fields merged in (counts, breakdowns).
   * @returns {Object}
   */
  function ruleViolationResult(ruleId, fields) {
    var rule = ruleById(ruleId);
    var result = {
      error: true,
      code: ruleId,
      rule_id: ruleId,
      applied: null
    };
    if (rule) {
      result.reason = fields && fields.reason ? fields.reason : rule.rule;
      result.enforcement = rule.enforcement;
      result.rule_text = rule.rule;
    } else {
      result.reason = fields && fields.reason ? fields.reason : ruleId;
    }
    if (fields) {
      Object.keys(fields).forEach(function (key) {
        result[key] = fields[key];
      });
    }
    return result;
  }

  /**
   * Evaluate EVERY rq3 chain rule against a full candidate model.
   * Returns ALL violations found (callers reject on the first; building
   * them all keeps the engine testable in one pass).
   *
   * @param {Array<Object>} model - the complete candidate chain.
   * @returns {Array<Object>} violation result objects (possibly []).
   */
  function evaluateChainRules(model) {
    var limits = CHAIN_LIMITS;
    var violations = [];
    var i;

    // node-count-cap
    if (model.length > limits.MAX_NODES) {
      violations.push(ruleViolationResult('node-count-cap', {
        count: model.length,
        limit: limits.MAX_NODES,
        suggestion: 'Remove nodes until the chain has at most ' +
          limits.MAX_NODES + ' (all types, including the required limiter).'
      }));
    }

    // limiter-required-terminal (missing / not terminal / duplicated)
    var lastIdx = model.length - 1;
    var terminalIsLimiter = lastIdx >= 0 && model[lastIdx].type === 'limiter';
    if (!terminalIsLimiter) {
      violations.push(ruleViolationResult('limiter-required-terminal', {
        reason: model.length === 0
          ? 'The chain is empty — a limiter is REQUIRED and must be the terminal (last) node.'
          : "The terminal (last) node is a '" + model[lastIdx].type +
            "', but a limiter is REQUIRED and must be terminal (last, MIC IN to OUT).",
        suggestion: 'End the chain with exactly one limiter node; the agent may only add, remove or reorder UPSTREAM of it.'
      }));
    } else {
      for (i = 0; i < lastIdx; i++) {
        if (model[i].type === 'limiter') {
          violations.push(ruleViolationResult('limiter-required-terminal', {
            node: model[i].id,
            position: i,
            reason: "Node '" + model[i].id + "' is a limiter at position " + i +
              ' — nothing may sit after the limiter (it must be TERMINAL), and only one is allowed.',
            suggestion: 'Keep exactly one limiter as the LAST node; remove or move the duplicate.'
          }));
        }
      }
    }

    // gain-node-count / compressor-node-count / eq-max-bands
    var gainNodes = [];
    var compressorNodes = [];
    var eqNodes = [];
    model.forEach(function (entry) {
      if (entry.type === 'gain') { gainNodes.push(entry.id); }
      if (entry.type === 'compressor' || entry.type === 'limiter') {
        compressorNodes.push(entry.id);
      }
      if (entry.type === 'eq') { eqNodes.push(entry.id); }
    });
    if (gainNodes.length > limits.MAX_GAIN_NODES) {
      violations.push(ruleViolationResult('gain-node-count', {
        count: gainNodes.length, limit: limits.MAX_GAIN_NODES, nodes: gainNodes,
        suggestion: 'Remove gain nodes (or fold trims into one node) until there are at most ' +
          limits.MAX_GAIN_NODES + '.'
      }));
    }
    if (compressorNodes.length > limits.MAX_COMPRESSOR_NODES) {
      violations.push(ruleViolationResult('compressor-node-count', {
        count: compressorNodes.length, limit: limits.MAX_COMPRESSOR_NODES,
        nodes: compressorNodes,
        suggestion: "Keep at most one 'compressor' node beyond the required terminal limiter."
      }));
    }
    var eqBandsPerNode = paramSpecsFor('eq').length; // 3 bands per eq node, derived from the registry
    if (eqNodes.length > 0 &&
        eqNodes.length * eqBandsPerNode > limits.MAX_EQ_BANDS) {
      violations.push(ruleViolationResult('eq-max-bands', {
        bands: eqNodes.length * eqBandsPerNode,
        limit: limits.MAX_EQ_BANDS,
        eqNodes: eqNodes,
        bandsPerEqNode: eqBandsPerNode,
        suggestion: 'Keep at most ' + (limits.MAX_EQ_BANDS / eqBandsPerNode) +
          ' eq nodes (' + limits.MAX_EQ_BANDS + ' bands total).'
      }));
    }

    // eq-boost-sum / eq-single-big-boost (+ boost totals for the compound guard)
    var bandParams = paramSpecsFor('eq').map(function (spec) { return spec.id; });
    var boostSum = 0;
    var bigBands = [];
    var boostBreakdown = [];
    model.forEach(function (entry) {
      if (entry.type !== 'eq') { return; }
      var eff = effectiveParamsFor(entry);
      bandParams.forEach(function (band) {
        var value = eff[band];
        if (typeof value !== 'number' || value <= 0) { return; }
        boostSum += value;
        boostBreakdown.push({ node: entry.id, band: band, dB: round2(value) });
        if (value >= limits.EQ_SINGLE_BOOST_FLOOR_DB) {
          bigBands.push({ node: entry.id, band: band, dB: round2(value) });
        }
      });
    });
    if (boostSum > limits.EQ_BOOST_SUM_MAX_DB) {
      violations.push(ruleViolationResult('eq-boost-sum', {
        sumDb: round2(boostSum),
        limit: limits.EQ_BOOST_SUM_MAX_DB,
        remainingDb: round2(limits.EQ_BOOST_SUM_MAX_DB - boostSum),
        breakdown: boostBreakdown,
        suggestion: 'Reduce EQ boosts so their sum is at most +' +
          limits.EQ_BOOST_SUM_MAX_DB + ' dB (per band, at most +9 dB).'
      }));
    }
    if (bigBands.length > 1) {
      violations.push(ruleViolationResult('eq-single-big-boost', {
        bands: bigBands,
        limit: 1,
        suggestion: 'At most ONE EQ band may boost +' +
          limits.EQ_SINGLE_BOOST_FLOOR_DB + ' dB or more; cut the others back.'
      }));
    }

    // compound-loop-guard: feedback >= 0.55 linear (55 %) AND boost sum >= +6 dB
    var maxFeedback = null;
    var maxFeedbackNode = null;
    model.forEach(function (entry) {
      if (entry.type !== 'delay') { return; }
      var eff = effectiveParamsFor(entry);
      if (typeof eff.feedback === 'number' &&
          (maxFeedback === null || eff.feedback > maxFeedback)) {
        maxFeedback = eff.feedback;
        maxFeedbackNode = entry.id;
      }
    });
    if (maxFeedback !== null &&
        maxFeedback >= limits.COMPOUND_FEEDBACK_MIN_PCT &&
        boostSum >= limits.COMPOUND_BOOST_SUM_MIN_DB) {
      violations.push(ruleViolationResult('compound-loop-guard', {
        feedback: { node: maxFeedbackNode, value: maxFeedback, unit: '%' },
        feedbackThreshold: limits.COMPOUND_FEEDBACK_MIN_PCT,
        boostSumDb: round2(boostSum),
        boostSumThreshold: limits.COMPOUND_BOOST_SUM_MIN_DB,
        suggestion: 'High loop gain plus spectral lift is how ringback starts: lower delay feedback below ' +
          limits.COMPOUND_FEEDBACK_MIN_PCT + ' % or reduce the EQ boost sum below +' +
          limits.COMPOUND_BOOST_SUM_MIN_DB + ' dB.'
      }));
    }

    // gain-budget-12db (with per-node breakdown so the agent can trade)
    var budget = budgetBreakdown(model);
    if (budget.estimatedDb > limits.MAX_TOTAL_GAIN_DB) {
      violations.push(ruleViolationResult('gain-budget-12db', {
        budget: budget,
        suggestion: 'Reduce a gain node\'s gainDb, or raise compressor threshold / limiter ceiling ' +
          '(every +1 dB frees ~' + MAKEUP_DB_PER_THRESHOLD_DB +
          ' dB of estimated makeup) until the estimate fits +' +
          limits.MAX_TOTAL_GAIN_DB + ' dB.'
      }));
    }

    return violations;
  }

  /**
   * Structured per-param reject (rq3 treatment 'reject'): nothing applied,
   * allowed range inline, plus remaining-budget numbers when the param
   * feeds a cumulative constraint (gain budget).
   *
   * @param {string} nodeId
   * @param {string} type
   * @param {string} param
   * @param {Object} policy - the AGENT_PARAM_POLICY entry.
   * @param {number} requested
   * @param {Array<Object>} [budgetModel] - candidate entries for the
   *   would-be budget estimate (gain.gainDb / compressor.threshold /
   *   limiter.ceiling rejects only).
   * @returns {Object}
   */
  function paramRejectResult(nodeId, type, param, policy, requested, budgetModel) {
    var result = {
      error: true,
      code: 'PARAM_OUT_OF_RANGE',
      node: nodeId,
      param: param,
      requested: requested,
      allowed: { min: policy.min, max: policy.max, unit: policy.unit },
      applied: null,
      rule_id: paramRuleId(type, param),
      reason: "Node '" + nodeId + "' param '" + param + "': requested " +
        requested + ' ' + policy.unit + ' is outside the agent range [' +
        policy.min + ', ' + policy.max + '] ' + policy.unit +
        ' (rq3 treatment: reject — nothing was applied).',
      suggestion: 'Set ' + param + ' within [' + policy.min + ', ' +
        policy.max + '] ' + policy.unit + '.'
    };
    if (budgetModel &&
        ((type === 'gain' && param === 'gainDb') ||
         (type === 'compressor' && param === 'threshold') ||
         (type === 'limiter' && param === 'ceiling'))) {
      result.budget = budgetBreakdown(budgetModel);
    }
    return result;
  }

  /**
   * Apply the rq3 per-param policy to every PROVIDED param of a candidate
   * node list (omitted params keep the type defaults — a default can never
   * be an agent "request", which is also what keeps get_chain's output
   * round-tripping through set_chain for host-default values like the
   * limiter's factory ceiling). Rejects abort the whole mutation; clamps
   * saturate and are disclosed.
   *
   * @param {Array<Object>} nodes - raw {id, type, params?} entries.
   * @returns {{nodes: Array<Object>, clamped: Array<Object>, reject: Object|null}}
   */
  function applyPolicyToNodes(nodes) {
    var appliedNodes = [];
    var clamped = [];
    for (var i = 0; i < nodes.length; i++) {
      var entry = nodes[i];
      var params = effectiveParamsFor(entry); // defaults first
      var provided = entry.params || {};
      var keys = Object.keys(provided);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var value = provided[key];
        var policy = policyFor(entry.type, key);
        if (!policy) {
          params[key] = value; // no policy registered (registry drift) — nominal bounds already held structurally
          continue;
        }
        if (value < policy.min || value > policy.max) {
          if (policy.treatment === 'reject') {
            return {
              nodes: appliedNodes,
              clamped: clamped,
              reject: paramRejectResult(entry.id, entry.type, key, policy, value, nodes)
            };
          }
          var saturated = value < policy.min ? policy.min : policy.max;
          params[key] = saturated;
          clamped.push({
            node: entry.id,
            param: key,
            requested: value,
            applied: saturated,
            unit: policy.unit,
            rule_id: paramRuleId(entry.type, key)
          });
        } else {
          params[key] = value;
        }
      }
      appliedNodes.push({ id: entry.id, type: entry.type, params: params });
    }
    return { nodes: appliedNodes, clamped: clamped, reject: null };
  }

  /**
   * Compact, operator-facing one-liner for a checkChain() violation —
   * the silkscreen register (short, plain, no agent prose), shared by
   * the canvas policy note and the presets panel note (ADR-0002: warn,
   * never block). Falls back to the violation's own reason for any rule
   * this map does not name.
   *
   * @param {Object} violation - one checkChain() result entry.
   * @returns {string}
   */
  function humanSummary(violation) {
    var lines = {
      'limiter-required-terminal': 'limiter is not last in the chain',
      'gain-budget-12db': 'total gain is over the +12 dB budget',
      'node-count-cap': 'chain is over the ' + CHAIN_LIMITS.MAX_NODES + '-node cap',
      'gain-node-count': 'more than ' + CHAIN_LIMITS.MAX_GAIN_NODES + ' gain nodes',
      'compressor-node-count': 'more than ' + CHAIN_LIMITS.MAX_COMPRESSOR_NODES + ' compressor-type nodes',
      'eq-max-bands': 'too many EQ nodes (' + CHAIN_LIMITS.MAX_EQ_BANDS + ' bands max)',
      'eq-boost-sum': 'EQ boosts sum past +' + CHAIN_LIMITS.EQ_BOOST_SUM_MAX_DB + ' dB',
      'eq-single-big-boost': 'more than one EQ boost at +' + CHAIN_LIMITS.EQ_SINGLE_BOOST_FLOOR_DB + ' dB or higher',
      'compound-loop-guard': 'high delay feedback plus EQ boost — feedback risk'
    };
    if (violation && lines[violation.rule_id]) {
      return lines[violation.rule_id];
    }
    return violation && violation.reason ? String(violation.reason) : 'chain policy violation';
  }

  window.ChainPolicy = {
    // ------------------------------------------------------------------
    // Universal tier — chain rules (both actors; agents are refused,
    // operators are warned — ADR-0002).
    // ------------------------------------------------------------------
    checkChain: evaluateChainRules,
    humanSummary: humanSummary,
    budgetBreakdown: budgetBreakdown,
    ruleViolationResult: ruleViolationResult,
    ruleById: ruleById,
    CHAIN_LIMITS: CHAIN_LIMITS,
    CHAIN_RULES: CHAIN_RULES,
    MAKEUP_DB_PER_THRESHOLD_DB: MAKEUP_DB_PER_THRESHOLD_DB,
    // ------------------------------------------------------------------
    // Agent tier — agent param policy (agent mutations only; human
    // faders keep their full paramSpec travel).
    // ------------------------------------------------------------------
    applyPolicyToNodes: applyPolicyToNodes,
    policyFor: policyFor,
    hostOwnedFor: hostOwnedFor,
    paramRuleId: paramRuleId,
    paramRejectResult: paramRejectResult,
    AGENT_PARAM_POLICY: AGENT_PARAM_POLICY,
    HOST_OWNED_PARAMS: HOST_OWNED_PARAMS,
    // ------------------------------------------------------------------
    // Registry reads — live NodeTypes wins, static snapshot falls back
    // (registry unification is a recorded follow-up).
    // ------------------------------------------------------------------
    registryTypes: registryTypes,
    paramSpecsFor: paramSpecsFor,
    effectiveParamsFor: effectiveParamsFor,
    NODE_REGISTRY_SNAPSHOT: NODE_REGISTRY_SNAPSHOT,
    round2: round2
  };
})();
