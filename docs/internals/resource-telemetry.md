# Resource telemetry

Process counters come from a [standalone Rust monitor](../../native/resource-monitor/src/main.rs)
using `sysinfo`. Electron main supplies host power and Electron process metrics.
Keeping native collection outside Node isolates collector crashes and avoids a
Node/Electron addon ABI matrix. Desktop and CLI servers use the same child-process
protocol. A missing or failed collector leaves the server running.

The Connections machine-health panel deliberately uses a separate aggregate
subscription. It exposes only the T3 process count, total CPU, total resident
memory, collector status, and sample time. The full diagnostics stream remains
separate because it includes process identities and commands. Host storage is
reported only as total and available bytes for the filesystem containing the
server workspace; volume names, paths, and file names do not cross the RPC.

Clients judge freshness from the time each response was received instead of
comparing host clocks. This avoids false stale states when connected machines
have clock skew. Host capacity is polled while Connections is mounted; aggregate
T3 usage remains subscription-driven, so the native monitor still stops when no
diagnostics or machine-health consumer is present.

When the native collector is unavailable and there are no aggregate process
rows, the summary falls back to Node's current server RSS only. It reports
`coverage: server-only` and a null CPU value; clients must not present that
fallback as total T3 or agent usage.

Alert thresholds are per-environment client settings. They classify display
state only and never restart, signal, clean, throttle, notify, or otherwise act
on a host. The Connections view retains no more than 60 host samples per visible
environment for session peak summaries; leaving the view releases that history.

## Collection cost

The native child owns sampling and bounded in-memory history. The server requests
continuous snapshots only while diagnostics has live subscribers and fetches
history on demand. Consuming host power for background scheduling must not retain
live diagnostics. There is no telemetry database or recurring shell-probe fallback.

History has independent bounds for age, snapshot count, process rows, and retained
bytes. A count limit alone cannot bound memory when command lines vary in size.
Large process trees therefore shorten the available history window. Linux task
enumeration is disabled because walking every `/proc/<pid>/task/<tid>` directory
makes sampling itself expensive.

Electron power updates travel over private inherited pipes, independent of the
renderer connection. Power events and slow heartbeats continue with diagnostics
closed; `app.getAppMetrics()` runs only on live demand. The receiver's stale deadline
must exceed the slowest configured heartbeat plus scheduling grace, or intentional
idle polling makes background policy oscillate between constrained and
unconstrained states. Headless servers leave unavailable power data unknown.

## Measurement traps

- Process identity includes start time because operating systems reuse PIDs.
  Electron and native start times have different precision, so merging allows a
  small tolerance. Process signaling rechecks the native identity with a fresh
  sample.
- Snapshot sequence numbers belong to a monitor generation. Comparing them across
  restarts would discard the new monitor's samples until its sequence caught up.
- Sampling can miss a process that starts and exits between samples. Cumulative
  counters still yield deltas for processes observed across samples.
- Windows process I/O includes more than disk traffic. Unix counters report storage
  I/O, which can differ from logical application reads and writes because of OS
  caching. Keep instrumented logical I/O separate from these counters.
- Group totals accumulate observed deltas since telemetry started. Per-process
  cumulative counters cover the operating system's lifetime for that process.
- Historical replay uses native samples without current Electron CPU or memory
  metrics. Merging the latest Electron values would overwrite the past.

A WSL backend needs a Linux monitor even though Electron runs on Windows. Windows
desktop packages currently supply only the Windows executable, so native process
telemetry for the WSL backend is unavailable. The inherited Electron power feed
still works.
