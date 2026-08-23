# Battery usage

Live battery draw, charge and discharge sessions, and the times a person actually asks for: remaining, elapsed, and completed.

## Language

**Remaining time**:
Estimated time until the battery is full while charging, or empty while discharging.
_Avoid_: duration, session time, charging time, discharging time

**Elapsed session time**:
Wall-clock time since the current charging session or discharging session started.
_Avoid_: since last plugged, plug-in time, hours on AC, time on battery

**Charging session**:
A period when the battery is charging. A switch to discharging shorter than five minutes does not end it; fully charged, holding, or pending-charge does.
_Avoid_: plugged in, on AC

**Discharging session**:
A period when the battery is discharging. A switch to charging shorter than five minutes does not end it.
_Avoid_: on battery, unplugged

**Session interruption**:
A switch to the opposite energy-flow direction. Shorter than five minutes it is discarded and the original session continues. Five minutes or longer it completes the original session and is itself a session.
_Avoid_: flicker, gap, unplug

**Completed session duration**:
How long a finished charging session or discharging session lasted. A discarded session interruption is not a completed session.
_Avoid_: remaining time, elapsed session time

**Unplugged interval**:
A period from an observed AC disconnection until the next observed AC reconnection. It is based on connection state, not energy flow, and can include incomplete or idle battery-state observations. Its elapsed time sums continuously sampled slices and excludes gaps longer than one minute, when the laptop is assumed to be off or suspended. `Last time on battery` is the most recent completed unplugged interval; `Time on battery now` is the current open one.
_Avoid_: discharging session, charging session
