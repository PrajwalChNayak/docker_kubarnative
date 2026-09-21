---
title: Logging drivers
description: Choose between json-file, local, journald and the shipping drivers, and set rotation before a log file fills the disk.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - docker-beginner/inspect-logs-exec
  - docker-advanced/daemon-configuration
---

## Overview

A container's stdout and stderr go to a logging driver. The default driver,
`json-file`, does not rotate unless you tell it to, which is how a
long-running container fills `/var/lib/docker` and takes the daemon with it.
Choosing a driver is mostly about two questions: where do logs need to end
up, and does `docker logs` still have to work.

## Why it exists and when to use it

Containers are ephemeral; their logs must not be. The driver is the seam
between "the process wrote a line" and "an operator can find it tomorrow".

Three situations:

- **Single host, human debugging.** `local` or `json-file` with rotation.
- **Host with systemd and central journald collection.** `journald`.
- **Central log system.** `fluentd`, `gelf`, `awslogs`, `splunk`, `gcplogs`,
  or — usually better — a collector that reads the files instead.

In Kubernetes this decision is made by the cluster, not by you: the kubelet
writes container logs to files on the node and an agent ships them. See
[logging architectures](../operations/logging-architectures.md).

## How it works underneath

The container's first process writes to file descriptors 1 and 2, which are
connected to the runtime rather than to a terminal. The daemon reads them and
hands each message to the driver with metadata: timestamp, stream, container
ID and configured labels or environment fields.

Delivery has two modes. **Blocking**, the default, hands messages straight to
the driver — if the driver is slow, the container's write blocks, which
means a slow log backend can stall your application. **Non-blocking** puts a
per-container ring buffer in between, sized by `max-buffer-size` (default
`1m`); when the buffer is full, "new messages will not be enqueued", so you
lose logs instead of stalling.

That trade-off is a real decision. For a payment service, losing log lines
may be worse than slowing down; for a web front end, the opposite.

**Dual logging** covers the gap that used to exist with shipping drivers.
Docker Engine uses the `local` driver as a cache "for reading the latest logs
of your containers", so `docker logs` works even when the primary driver is
`fluentd` or `awslogs`. The cache options are `cache-disabled` (`false`),
`cache-max-size` (`20m`), `cache-max-file` (`5`) and `cache-compress`
(`true`).

## The drivers

Supported drivers: `none`, `local`, `json-file`, `syslog`, `journald`,
`gelf`, `fluentd`, `awslogs`, `splunk`, `etwlogs`, `gcplogs`.

| Driver | Format | Rotates by default | `docker logs` | Notes |
|---|---|---|---|---|
| `json-file` | JSON per line | **no** | yes | Default. One JSON object per line, on disk |
| `local` | Compact binary | **yes** | yes | Docker recommends it to avoid disk exhaustion |
| `journald` | systemd journal | journal's own | yes | Good on systemd hosts; query with `journalctl` |
| `syslog` | RFC 5424 | remote | via cache | Ubiquitous, lossy over UDP |
| `fluentd` | Forward protocol | remote | via cache | Needs a reachable collector |
| `gelf` | GELF over UDP/TCP | remote | via cache | Graylog and compatible |
| `awslogs`, `gcplogs`, `splunk` | Vendor APIs | remote | via cache | Cost scales with volume |
| `none` | — | — | no | Discards logs entirely |

`local` defaults: `max-size` 20m, `max-file` 5, compression enabled — about
100 MB per container. Its files are "designed to be exclusively accessed by
the Docker daemon"; do not point a log shipper at them.

`json-file` defaults: `max-size` unlimited (`-1`), `max-file` 1, `compress`
false. In other words, no rotation at all until you configure it.

## Basic example

Daemon-wide default with rotation:

```json title="/etc/docker/daemon.json"
{
  "log-driver": "local",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  }
}
```

Per container:

```bash
docker run -d --name api \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  tasklane-api:0.1.0
```

```console include="captures/docker-advanced/info-logging.txt"
```

## Explanation

Changing the daemon default affects **new containers only**. Existing
containers keep the driver and options they were created with, so a fix
applied during an incident does nothing until the containers are recreated —
worth knowing before you restart the daemon at 3 a.m. and expect disk usage
to drop.

`max-file` only takes effect when `max-size` is also set: without a size
there is nothing to roll. This is the single most common misconfiguration,
and it looks correct in a config review.

`local` is the better default for hosts where a human reads logs
occasionally. It rotates, compresses and is read by `docker logs`. Its only
real drawback is that its files are not meant to be tailed by other tools —
if a shipper must read files, `json-file` is the format that everything
understands.

## Common patterns

### Structured logs from the application

Ship JSON from the program and let the driver be a transport. Tasklane's
services write structured lines; a collector can then index fields without
regex parsing. Avoid multi-line stack traces where you can, or configure the
collector to join them — the driver does not.

### Labels and environment as log metadata

```json title="/etc/docker/daemon.json"
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3",
    "labels": "app,component",
    "env": "DEPLOY_ENV"
  }
}
```

The named labels and variables are attached to every message, which is how
you tell two containers' logs apart downstream.

### Do not log to a file inside the container

A log file inside a container needs rotation, a volume, and a way to get out.
Writing to stdout costs none of that and is the one behaviour every platform
understands.

### Rate-limit noisy containers

A container logging at megabytes per second will saturate any driver.
Non-blocking mode with a bounded buffer protects the application; fixing the
log level protects everyone else.

## Production considerations

Set rotation on **every** host, at the daemon level, before anything else.
The failure it prevents — a full `/var/lib/docker` — takes down every
container on the host at once, and it happens at the least convenient time.

Budget volume. A busy service at 1 KB per request and 500 requests per second
produces about 40 GB a day. Central log systems bill for that, and the bill
is often discovered in month two.

For a shipping driver, plan for the collector being unavailable. Blocking
mode stalls containers; non-blocking drops messages. Either way, an outage in
the logging path becomes an application problem unless you decided in
advance.

On Kubernetes nodes the container runtime writes files and the kubelet
manages rotation; the Docker logging driver setting is irrelevant to pods.
Do not carry a Docker logging configuration into a cluster and expect it to
apply.

## Security considerations

- Logs leak. Tokens in URLs, request bodies with personal data, and stack
  traces containing configuration all end up in a system with different
  access control from the application. Redact at the source.
- `docker logs` is available to anyone with daemon access, which is root
  equivalent anyway; the more interesting exposure is the central system,
  where far more people have accounts.
- Log volume is an availability control. An attacker who can make you log a
  megabyte per request can fill your disk, which is why rotation and rate
  limits are security settings, not housekeeping.
- Retention has legal weight in some jurisdictions. Set it deliberately, both
  the minimum and the maximum.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Disk full under `/var/lib/docker/containers` | `json-file` without rotation | Set `max-size`; recreate the containers |
| Rotation configured but files still grow | `max-file` without `max-size` | Set both |
| `docker logs` prints nothing | Driver is `none`, or the app writes to a file | Check `docker inspect` `.HostConfig.LogConfig` |
| Application stalls when the collector is down | Blocking delivery | `mode=non-blocking` with a sized buffer, and fix the collector |
| Logs missing after a burst | Non-blocking buffer overflow | Increase `max-buffer-size`, reduce log volume |
| New daemon default has no effect | Existing containers keep their config | Recreate them |

## Common mistakes

- Leaving the default `json-file` with no rotation and discovering it during
  an outage.
- Setting `max-file` only.
- Pointing a log shipper at `local` driver files.
- Logging at debug level in production "temporarily".
- Assuming the driver joins multi-line stack traces. It does not.
- Configuring Docker logging on Kubernetes nodes and expecting it to affect
  pod logs.

## Related topics

- [Daemon configuration](daemon-configuration.md)
- [Resource limits](resource-limits.md)
- [Inspect, logs and exec](../docker-beginner/inspect-logs-exec.md)
- [Cleanup and disk usage](../docker-beginner/cleanup-and-disk-usage.md)
- [Logging architectures](../operations/logging-architectures.md)
- [Docker disk exhaustion](../troubleshooting/docker-disk-exhaustion.md)
