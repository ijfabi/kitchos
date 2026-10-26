# Service level objectives (targets, not achieved results)

| Objective                        | Target                      | Measurement (planned)                               |
| -------------------------------- | --------------------------- | --------------------------------------------------- |
| Cloud API availability           | 99.99% monthly              | ALB 5xx + synthetic checks; error budget 4.3 min/mo |
| Order placement latency          | p95 < 250 ms (defined load) | `kitchos_http_request_duration_seconds` histogram   |
| Kitchen command latency          | p95 < 150 ms                | same                                                |
| Duplicate inventory deductions   | 0 under replay tests        | ledger unique constraint + reconciliation tests     |
| Duplicate financial postings     | 0 under replay tests        | Phase 3                                             |
| Local ordering during WAN outage | continues                   | Phase 6 store edge                                  |

No uptime is guaranteed. Availability is pursued through multi-AZ stateless replicas, managed
PostgreSQL failover, graceful degradation (live events → polling) and, from Phase 6, store-local
operation. RTO/RPO targets will be set with the Terraform reference stack and verified by
restore drills.
