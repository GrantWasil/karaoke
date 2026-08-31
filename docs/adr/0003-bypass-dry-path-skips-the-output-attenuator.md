# The Bypass dry path deliberately skips the Output Attenuator

Bypass routes the mic source directly to `audioContext.destination`; it does
not pass through the Output Attenuator that enforces the −6 dBFS ceiling on
the wet path. This is deliberate: the emergency path must be the simplest
possible route — acoustically equivalent to "no app" — and must not share
failure modes with the chain it exists to escape. Consequence: the −6 dBFS
ceiling claim applies to the wet path only, and acceptance documentation
should state it that way. Do not "fix" Bypass by routing it through the
attenuator.
