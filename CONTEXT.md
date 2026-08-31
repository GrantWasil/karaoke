# Karaoke Chain Builder

A browser-based live vocal effects box: mic in, a user-composed chain of Web
Audio effects, speakers out. Two actors edit the same chain — the human
operator and an in-browser agent driving WebMCP tools.

## Language

### Signal path

**Chain**:
The ordered sequence of nodes between the MIC IN and OUT anchors.
_Avoid_: graph, pipeline

**Node**:
One effect in the chain — gain, compressor, EQ, delay, reverb, or limiter.
_Avoid_: effect, plugin, module (reserved for design vocabulary)

**Output Attenuator**:
The fixed gain stage enforcing the −6 dBFS ceiling on the wet path. The
Bypass dry path deliberately does not pass through it (ADR-0003).

### Audibility

**Output Gate**:
The single owner of whether the chain is audible. All silence requests go
through it as holds; nothing else writes the gate's gain.
_Avoid_: chain gate, mute gain

**Hold**:
An active reason the output must be silent: `watchdog`, `bypass`, or `duck`.
The output is audible only when no holds are active. Precedence and ramp
curves live inside the Output Gate (ADR-0001).

**Watchdog**:
The safety monitor that trips on runaway output or howl and latches a
watchdog hold until the operator restores it. The latch belongs to the
watchdog, not the gate.

**Bypass**:
The emergency control: dry mic straight to the speakers, chain silenced.
Always one human action away; never available to the agent.

**Duck**:
The brief hold while the chain is rewired, so edits never click or pop.

### Policy

**Chain Policy**:
The module holding every rule about what a chain may look like and how loud
it may get. Both actors' edits are evaluated against it (ADR-0002).
_Avoid_: loudness policy, safety rules

**Chain rules**:
Chain Policy's universal tier — structural and loudness rules (terminal
limiter, node caps, the +12 dB gain budget) that apply to any chain
regardless of who built it. Violations refuse the agent and warn the human.

**Agent param policy**:
Chain Policy's agent-only tier — per-param ranges tighter than the human
fader travel. Applies to agent mutations only; human faders keep full range.

### Actors

**Operator**:
The human running the show. Warned, never blocked (ADR-0002).

**Agent**:
The in-browser AI driving the WebMCP tools. Refused or clamped by Chain
Policy; never controls Bypass, engine start/stop, or mic device.

**Preset**:
A named, saved chain. Distinct from the autosave, which is the unnamed
always-current chain.
