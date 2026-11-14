# Performance

**No benchmark has been run on KitchOS, and no performance figures are claimed anywhere in this
repository.** Durations printed by the test runners measure test suites, not the system, and are
not benchmarks.

## What is known qualitatively

These follow from the design and are recorded as risks, not measured:

- Order placement is serialised per restaurant and business day by the order number counter, and
  event production per restaurant by the event sequence row (R-001). Throughput per restaurant is
  therefore bounded by how quickly one such transaction commits.
- The ledger dispatcher scans the outbox with anti-joins on every pass, so its cost grows with
  history until a retention job exists (R-015, R-008).
- Every order, payment, refund and discount insert takes a shared advisory lock for shift stamping.
  A shift open or close briefly holds those writes back at that restaurant (ADR-0018).

## Rules for publishing results

A result may be added here only with all of the following:

1. **Hardware and environment:** CPU, memory, storage, operating system, PostgreSQL and Node.js
   versions, and whether the database was local, containerised or managed.
2. **Workload:** the scenario script (k6 is planned), data volume, number of restaurants, menu
   size, concurrency, think time and the mix of operations.
3. **Duration:** warm-up and measured period.
4. **Raw results:** the tool's output files, committed next to the summary, with latency
   percentiles, throughput and error rates.
5. **Commit:** the exact commit measured.

Targets that results will be compared against are in [slo.md](../reliability/slo.md). They are
targets, not achieved figures.
