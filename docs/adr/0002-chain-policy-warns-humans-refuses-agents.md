# Chain Policy refuses the agent but only warns the operator

The loudness policy (chain rules: terminal limiter, node caps, the +12 dB
gain budget) was enforced only on the agent path; the operator could build
chains the agent would be refused. We extracted the policy into Chain Policy
and now evaluate both actors' edits against it — but asymmetrically: agent
mutations are refused or clamped as before, while operator edits always
stand and violations surface as a quiet note (canvas note for drag/reorder,
preset note for loads, debounced note for fader moves). Refusing a human
mid-setup contradicts "the show comes first" and "brother-usable"; Bypass
remains the real safety net.

The asymmetry is two named tiers inside one module: **chain rules** (both
actors) and **agent param policy** (agent only — human faders keep their
full travel; clamping them would silently regress existing range).

Existing silent auto-fixes stay as they are (keyboard add inserts before the
terminal limiter); they predate this decision and are not enforcement.

Do not re-suggest symmetric enforcement without revisiting this trade-off.
