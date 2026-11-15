### 5 PM users

2026-11-15T16:07:58.873Z to 2026-11-15T16:16:59.540Z; 9.01 minutes; stop: duration. 177 physical calls, 104 business operations (103 successful), 74 handle responses (41.81% of physical calls); 33/104 initial calls returned handles. Errors 0.00%. Highest observed successful per-user rolling-minute consumption: 28 weighted credits. Max RSS: unavailable (sandbox PID namespace). Responsiveness p95: 0.870 s; 0/96 probe errors. Sampled active jobs max 5 (5 test-owned); pending-work proxy max 3; 69/96 samples above two active jobs.

| Tool | Calls | First p50/p95/p99, all (s) | First p50/p95/p99, non-error (s) | Final p50/p95/p99, successful (s) | Handles | Errors / physical calls | Censored |
|---|---:|---|---|---|---:|---|---:|
| aggregate_events | 7 | 20.058 / 20.157 / 20.157 | 20.058 / 20.157 / 20.157 | 85.312 / 137.868 / 137.868 | 100.00% | 0 | 1 |
| client_signals | 5 | 0.423 / 3.992 / 3.992 | 0.423 / 3.992 / 3.992 | 0.424 / 3.993 / 3.993 | 0.00% | 0 | 0 |
| client_story | 17 | 7.607 / 20.142 / 20.142 | 7.607 / 20.142 / 20.142 | 7.607 / 53.260 / 53.260 | 29.41% | 0 | 0 |
| compare_client_patterns | 5 | 11.468 / 20.042 / 20.042 | 11.468 / 20.042 / 20.042 | 11.468 / 25.151 / 25.151 | 20.00% | 0 | 0 |
| dialog_friction | 12 | 2.752 / 20.853 / 20.853 | 2.752 / 20.853 / 20.853 | 2.756 / 75.634 / 75.634 | 25.00% | 0 | 0 |
| discover_workflows | 5 | 20.034 / 20.599 / 20.599 | 20.034 / 20.599 / 20.599 | 29.468 / 37.763 / 37.763 | 80.00% | 0 | 0 |
| get_job_result | 73 | 15.039 / 15.136 / 15.156 | 15.039 / 15.136 / 15.156 | 2.084 / 13.072 / 14.018 | 56.16% | 0 | 0 |
| rescue_queue | 12 | 8.204 / 20.126 / 20.126 | 8.204 / 20.126 / 20.126 | 8.205 / 78.419 / 78.419 | 25.00% | 0 | 0 |
| resolve_client | 11 | 0.185 / 0.214 / 0.214 | 0.185 / 0.214 / 0.214 | 0.185 / 0.214 / 0.214 | 0.00% | 0 | 0 |
| task_map | 12 | 0.663 / 20.119 / 20.119 | 0.663 / 20.119 / 20.119 | 0.663 / 65.268 / 65.268 | 25.00% | 0 | 0 |
| top_pains | 13 | 0.268 / 20.065 / 20.065 | 0.268 / 20.065 / 20.065 | 0.269 / 65.311 / 65.311 | 15.38% | 0 | 0 |
| workflow_completion | 5 | 20.060 / 20.520 / 20.520 | 20.060 / 20.520 / 20.520 | 57.038 / 69.068 / 69.068 | 100.00% | 0 | 0 |

### 10 PM users

2026-11-15T16:17:01.375Z to 2026-11-15T16:26:01.128Z; 9.00 minutes; stop: duration. 281 physical calls, 85 business operations (85 successful), 196 handle responses (69.75% of physical calls); 69/85 initial calls returned handles. Errors 0.00%. Highest observed successful per-user rolling-minute consumption: 16 weighted credits. Max RSS: unavailable (sandbox PID namespace). Responsiveness p95: 0.965 s; 0/96 probe errors. Sampled active jobs max 10 (10 test-owned); pending-work proxy max 8; 94/96 samples above two active jobs.

| Tool | Calls | First p50/p95/p99, all (s) | First p50/p95/p99, non-error (s) | Final p50/p95/p99, successful (s) | Handles | Errors / physical calls | Censored |
|---|---:|---|---|---|---:|---|---:|
| aggregate_events | 7 | 20.061 / 20.975 / 20.975 | 20.061 / 20.975 / 20.975 | 131.365 / 150.902 / 150.902 | 100.00% | 0 | 0 |
| client_signals | 0 | — / — / — | — / — / — | — / — / — | — | 0 | 0 |
| client_story | 14 | 20.086 / 20.553 / 20.553 | 20.086 / 20.553 / 20.553 | 46.159 / 120.416 / 120.416 | 85.71% | 0 | 0 |
| compare_client_patterns | 1 | 20.121 / 20.121 / 20.121 | 20.121 / 20.121 / 20.121 | 86.995 / 86.995 / 86.995 | 100.00% | 0 | 0 |
| dialog_friction | 10 | 20.045 / 20.158 / 20.158 | 20.045 / 20.158 / 20.158 | 45.356 / 105.361 / 105.361 | 90.00% | 0 | 0 |
| discover_workflows | 8 | 20.090 / 20.357 / 20.357 | 20.090 / 20.357 / 20.357 | 54.444 / 129.443 / 129.443 | 100.00% | 0 | 0 |
| get_job_result | 196 | 15.036 / 15.251 / 15.689 | 15.036 / 15.251 / 15.689 | 3.228 / 13.947 / 15.073 | 64.80% | 0 | 0 |
| rescue_queue | 11 | 20.052 / 20.417 / 20.417 | 20.052 / 20.417 / 20.417 | 49.596 / 106.217 / 106.217 | 90.91% | 0 | 0 |
| resolve_client | 9 | 0.443 / 1.900 / 1.900 | 0.443 / 1.900 / 1.900 | 0.443 / 1.900 / 1.900 | 0.00% | 0 | 0 |
| task_map | 12 | 20.044 / 20.506 / 20.506 | 20.044 / 20.506 / 20.506 | 46.143 / 85.518 / 85.518 | 83.33% | 0 | 0 |
| top_pains | 8 | 20.068 / 20.291 / 20.291 | 20.068 / 20.291 / 20.291 | 45.910 / 93.732 / 93.732 | 87.50% | 0 | 0 |
| workflow_completion | 5 | 20.113 / 20.272 / 20.272 | 20.113 / 20.272 / 20.272 | 80.272 / 114.162 / 114.162 | 100.00% | 0 | 0 |

### 20 PM users

2026-11-15T16:26:01.800Z to 2026-11-15T16:35:19.214Z; 9.29 minutes; stop: duration. 577 physical calls, 136 business operations (124 successful), 453 handle responses (78.51% of physical calls); 114/136 initial calls returned handles. Errors 0.00%. Highest observed successful per-user rolling-minute consumption: 13 weighted credits. Max RSS: unavailable (sandbox PID namespace). Responsiveness p95: 0.748 s; 0/96 probe errors. Sampled active jobs max 20 (20 test-owned); pending-work proxy max 18; 95/96 samples above two active jobs.

| Tool | Calls | First p50/p95/p99, all (s) | First p50/p95/p99, non-error (s) | Final p50/p95/p99, successful (s) | Handles | Errors / physical calls | Censored |
|---|---:|---|---|---|---:|---|---:|
| aggregate_events | 9 | 20.064 / 20.175 / 20.175 | 20.064 / 20.175 / 20.175 | 125.649 / 170.202 / 170.202 | 100.00% | 0 | 2 |
| client_signals | 6 | 20.031 / 20.117 / 20.117 | 20.031 / 20.117 / 20.117 | 65.224 / 128.047 / 128.047 | 83.33% | 0 | 1 |
| client_story | 22 | 20.042 / 20.419 / 20.621 | 20.042 / 20.419 / 20.621 | 66.678 / 126.145 / 128.827 | 90.91% | 0 | 2 |
| compare_client_patterns | 6 | 20.038 / 20.126 / 20.126 | 20.038 / 20.126 / 20.126 | 75.101 / 116.240 / 116.240 | 100.00% | 0 | 0 |
| dialog_friction | 17 | 20.045 / 20.626 / 20.626 | 20.045 / 20.626 / 20.626 | 52.487 / 129.651 / 129.651 | 88.24% | 0 | 1 |
| discover_workflows | 9 | 20.056 / 20.211 / 20.211 | 20.056 / 20.211 / 20.211 | 93.575 / 145.874 / 145.874 | 100.00% | 0 | 2 |
| get_job_result | 441 | 15.030 / 15.137 / 15.255 | 15.030 / 15.137 / 15.255 | 2.821 / 13.636 / 14.040 | 76.87% | 0 | 0 |
| rescue_queue | 16 | 20.034 / 20.688 / 20.688 | 20.034 / 20.688 / 20.688 | 85.441 / 125.593 / 125.593 | 93.75% | 0 | 1 |
| resolve_client | 13 | 0.192 / 0.858 / 0.858 | 0.192 / 0.858 / 0.858 | 0.193 / 0.858 / 0.858 | 0.00% | 0 | 0 |
| task_map | 17 | 20.040 / 20.302 / 20.302 | 20.040 / 20.302 / 20.302 | 65.127 / 128.156 / 128.156 | 88.24% | 0 | 1 |
| top_pains | 16 | 20.042 / 20.222 / 20.222 | 20.042 / 20.222 / 20.222 | 67.102 / 127.025 / 127.025 | 93.75% | 0 | 2 |
| workflow_completion | 5 | 20.043 / 20.167 / 20.167 | 20.043 / 20.167 / 20.167 | 125.235 / 148.222 / 148.222 | 100.00% | 0 | 0 |