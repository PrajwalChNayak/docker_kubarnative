# Node-agent logging with Grafana Alloy

`alloy-daemonset.yaml` runs Grafana Alloy as a DaemonSet — one pod per node —
that tails the logs of the pods on its node and ships them to Loki.

Written against Alloy **v1.19.2**, Loki **v3.7.8**. Loki is AGPLv3; running it
internally is fine, redistributing a modified Loki obliges you to share source.

## Why Alloy and not Promtail

Promtail is **deprecated**: Grafana put it into feature-freeze/LTS in February
2025 and has announced end-of-life for early 2026, steering users to Alloy (the
successor that merges the old Grafana Agent). Do not start new work on Promtail.

## The three logging architectures

| Architecture | How | When |
|---|---|---|
| **Node agent** (this example) | One DaemonSet pod per node reads every pod's logs and forwards them. | Default for Kubernetes. Cheapest and most uniform; the app just writes to stdout. |
| **Sidecar** | A logging container in each pod tails a shared volume or the app's files. | Only when the app cannot log to stdout, writes multiple log files, or needs per-app parsing the node agent cannot do. Costs one extra container per pod. |
| **Direct write** | The app ships logs to the backend itself (SDK/appender). | Avoid in Kubernetes: couples the app to the backend, loses logs on backend outage, and bypasses the platform's retention/PII controls. |

## API-tail vs file-tail

This manifest uses `loki.source.kubernetes`, which reads logs **through the
Kubernetes API**. That needs no `hostPath` and runs as a **non-root** user, at
the cost of load on the API server. The classic node-agent form instead mounts
`/var/log/pods` as a `hostPath` and uses `loki.source.file`; those files are
root-owned, so that variant must run as **root**. Prefer the API-tail form in
the lab; use file-tail at scale where API load matters.

## Install

Install Loki first (Grafana's `loki` Helm chart, `monitoring` namespace), then:

```bash
kubectl apply -f examples/operations/logging/alloy-daemonset.yaml
```

## Label cardinality — the one rule that matters

Loki indexes by label set; every distinct combination is a separate stream.
Keep labels low-cardinality: `namespace`, `app`, `container`, `level`. **Never**
put pod name, request id, user id, or trace id in a Loki label — put those in
the log line and let LogQL filter them. This example deliberately drops the pod
label for that reason.

## Structured logging, retention, PII

Tasklane logs JSON to stdout (12-factor). The `loki.process` stage lifts
`level` to a label so severity filtering is cheap. Set retention on Loki (not on
the agent), and scrub or avoid PII before it reaches the log line — deletion
from an immutable log store is slow and sometimes impossible.
