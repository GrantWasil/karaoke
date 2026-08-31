# The Output Gate is the only writer of chain audibility

Three modules used to schedule automation on the chain gate GainNode directly
(rebuild duck in audio-graph, Bypass, watchdog mute), each re-deriving
precedence by querying the others, with a polling defender (`defendMute`)
catching writers that got it wrong. We decided one module — the Output Gate —
owns the gate node's gain exclusively, behind boolean holds
(`hold(reason)` / `release(reason)` for `watchdog`, `bypass`, `duck`).
Precedence is a single internal rule: any active hold means silence; targets
and per-reason ramp curves (mute τ, restore τ, 15 ms duck, 5 ms bypass) are
implementation, not interface.

## Considered Options

- `request(reason, target)` with caller-supplied targets — rejected: wrong
  targets are exactly the historical bug class.
- Declarative `set({watchdog, bypass, duck})` — rejected: every caller must
  know all reasons to avoid clobbering the others.

## Consequences

- The watchdog latch (trip-until-human-restore) stays in the watchdog; the
  gate is a memoryless arbiter. Releasing one hold while another is active
  keeps the output silent with no cross-module checks.
- `getChainGate()` leaves the public interface; AudioGraph still creates and
  wires the node (topology), then hands it over once via `attach`.
- A demoted invariant check (self-armed 250 ms interval, active only while a
  hold is active) replaces `defendMute` — it guards against Web Audio
  scheduling races, not foreign modules.
- AudioParamRamp stays a node-param module; it was deliberately not grown a
  duration/mode parameter to serve the gate's four single-caller curves.
