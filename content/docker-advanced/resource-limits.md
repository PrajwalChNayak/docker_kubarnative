---
title: Resource limits
description: Map --memory, --cpus, --pids-limit and --ulimit onto cgroup v2 files, and understand what the kernel does when a container exceeds them.
level: advanced
type: concept
status: current
versions: Docker Engine 29, Buildx 0.37
prerequisites:
  - foundations/cgroups-v2
  - docker-beginner/running-containers
---

## Overview

A container without limits can consume every core and every byte on the host.
The kernel's answer is cgroups; Docker's flags are a thin translation layer
over cgroup v2 files. Knowing which file each flag writes turns "the
container died" into a diagnosis, because the kernel's behaviour at the limit
differs sharply between memory (kill) and CPU (throttle).

cgroup v2 is the baseline. Kubernetes has deprecated cgroup v1 since 1.35,
and Docker Engine 29 deprecates it too, with support continuing "until at
least May 2029" per the release notes.

## Why it exists and when to use it

Without limits, one leaking process takes down everything on the box. With
limits, it takes down itself. That is the entire argument, and it applies to
a laptop running Compose exactly as it applies to a cluster.

Limits also make behaviour *legible*. A service that is slow because it is
CPU-throttled looks completely different from one that is slow because of a
lock, and you cannot see throttling at all unless a limit exists.

Set limits on everything you run in production, on anything untrusted, and on
local stacks where a runaway build should not freeze your machine.

## How it works underneath

The runtime creates a cgroup per container and writes the limits into it.
Under cgroup v2, the interesting files are:

| Flag | cgroup v2 file | Kernel behaviour at the limit |
|---|---|---|
| `--memory` / `-m` | `memory.max` | Reclaim, then the OOM killer kills a process in the cgroup |
| `--memory-reservation` | `memory.low` | Soft: reclaim prefers other cgroups first |
| `--memory-swap` | `memory.swap.max` (limit minus `--memory`) | Swapping instead of OOM, if swap exists |
| `--cpus` | `cpu.max` (quota and period) | Hard throttle within each period |
| `--cpu-shares` | `cpu.weight` | Relative share, only under contention |
| `--cpuset-cpus` | `cpuset.cpus` | Restricts which cores may run the tasks |
| `--pids-limit` | `pids.max` | `fork()` fails with EAGAIN |

Two behaviours are worth internalising.

**Memory is a cliff.** When a cgroup hits `memory.max`, the kernel reclaims
what it can and then invokes the OOM killer inside that cgroup. The container
does not get a warning and the process does not get a chance to shed load; it
gets SIGKILL. In `docker inspect` the state shows `OOMKilled: true`, and in
Kubernetes it is exit code 137.

**CPU is a slope.** `cpu.max` is a quota per period, typically 100 ms. A
container at its quota is *stopped* until the next period begins. Average CPU
usage looks healthy; tail latency is awful. The signal to look for is
`nr_throttled` and `throttled_usec` in `cpu.stat`, not utilisation.

### The 1024 nofile default

Engine 29 changed a default that had been unnoticed for years: containerd
2.1.5 sets `ulimit -n` to systemd's default, **1024 instead of 1048576**, for
all containers. A server that opens thousands of sockets now hits
`too many open files` where it previously did not. Override per container
with `--ulimit nofile=...`, or globally with `default-ulimits` in
`daemon.json`.

```bash
docker run --rm busybox:1.37-musl sh -c 'ulimit -Sn; ulimit -Hn'
```

```console include="captures/docker-advanced/ulimit-default.txt"
```

## Basic example

```bash
docker run --rm --memory 128m --cpus 0.5 --pids-limit 64 \
  busybox:1.37-musl sh -c 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max'
```

```console include="captures/docker-advanced/cgroup-limits.txt"
```

The Compose stack sets the same kind of limits declaratively:

```yaml include="examples/compose/compose.yaml" lines="82-86"
```

## Explanation

Reading the cgroup files from inside the container is the only way to be sure
a limit was applied. Flags can be silently ineffective — under rootless
Docker without delegated controllers, for example — and a limit you believe
in but do not have is worse than no limit.

`--cpus 0.5` writes a quota and a period into `cpu.max`; the container may
use half a core on average, in bursts bounded by the period. `--memory 128m`
writes `memory.max`; exceed it and something in the container dies.
`--pids-limit 64` bounds fork bombs and runaway thread creation, and it is
the cheapest denial-of-service mitigation available.

## Common patterns

### Memory limit and application heap must agree

A JVM with `-Xmx2g` in a 1 GiB container will be OOM-killed. Modern runtimes
read cgroup limits (`-XX:+UseContainerSupport` is default on current JVMs;
Go's `GOMEMLIMIT`; Node's `--max-old-space-size`), but only if you let them.
Set the limit, then tell the runtime about it, and leave headroom for
non-heap memory.

### Reservation for scheduling, limit for safety

`--memory-reservation` below `--memory` gives the kernel a hint about who to
reclaim from first under pressure, while the hard limit still bounds the
worst case. The Docker documentation notes the reservation "must be set lower
than --memory for it to take precedence".

### Pids limit everywhere

`--pids-limit 100` on an application container costs nothing and stops a fork
bomb from taking the host's process table.

### Watch throttling, not utilisation

```bash
docker stats --no-stream
```

```console include="captures/docker-advanced/stats-once.txt"
```

`docker stats` shows utilisation. For throttling, read `cpu.stat` in the
container's cgroup, or export it through your metrics pipeline. In
Kubernetes, `container_cpu_cfs_throttled_seconds_total` is the same signal.

### Do not disable the OOM killer

`--oom-kill-disable` without `-m` risks the host's OOM killer choosing a
system process instead. The documented advice is to never use it without a
memory limit; the better advice is to not use it at all.

## Production considerations

Limits belong in the orchestrator, not in `docker run`, for anything beyond a
single host. Kubernetes requests and limits map onto the same cgroup files,
with additional semantics around QoS classes and eviction; see
[resources, requests and limits](../k8s-intermediate/resources-requests-limits.md)
and [QoS classes](../k8s-intermediate/qos-classes.md).

Sizing is empirical. Start from observed usage plus headroom, not from a
round number. For memory, the right limit is above the peak working set of a
normal day, because the penalty for being slightly low is a kill.

CPU limits are more contentious than memory limits. A hard CPU quota on a
latency-sensitive service can hurt more than it helps; shares and requests
give you priority under contention without the periodic stalls. Measure tail
latency with and without.

Under rootless Docker, limits require cgroup v2 **and** systemd **and**
delegated controllers. See [rootless Docker](rootless-docker.md).

## Security considerations

- Limits are availability controls. A container with no `pids.max` can fork
  until the host cannot start new processes — a denial of service that needs
  no exploit.
- `--privileged` and a writable `/sys/fs/cgroup` let a container change its
  own limits. Keep the cgroup filesystem read-only inside containers.
- Memory limits reduce the blast radius of a memory-exhaustion bug but do not
  fix it. The process still dies; make sure the restart policy and the
  readiness signal behave.
- `--device-cgroup-rule` and `--cpuset-cpus` are also isolation controls on
  shared hardware, particularly where side-channel concerns apply.
- Resource exhaustion is the most common noisy-neighbour incident in
  multi-tenant clusters, and the one most often left unmitigated.

## Troubleshooting

| Symptom | Cause | Check |
|---|---|---|
| Container exits with 137 | OOM killed | `docker inspect --format '{{.State.OOMKilled}}' <id>`; kernel log |
| Slow under load, low CPU usage | CFS throttling | `cpu.stat` `nr_throttled`, `throttled_usec` |
| `too many open files` after upgrading to Engine 29 | 1024 nofile default | `--ulimit nofile=`, or `default-ulimits` |
| `fork: retry: Resource temporarily unavailable` | `pids.max` reached | Raise `--pids-limit`, or fix the leak |
| Limits ignored | Rootless without delegation, or cgroup v1 | `docker info`; delegate controllers |
| JVM ignores the limit | Old runtime or explicit heap flags | Container-aware flags; set heap under the limit |

## Common mistakes

- Setting a memory limit equal to observed peak usage. Peaks move.
- Assuming a CPU limit makes a service faster or more predictable. It bounds
  it; latency usually gets worse.
- Using `--memory-swap` without understanding that it is the *combined*
  limit, so `--memory 300m --memory-swap 1g` permits 700 MB of swap.
- Reading utilisation graphs and concluding there is CPU headroom while the
  container is throttled.
- Leaving `--pids-limit` unset because "our app does not fork".
- Forgetting that `docker run` limits do not carry over into Kubernetes; the
  manifest is the source of truth there.

## Related topics

- [Rootless Docker](rootless-docker.md)
- [Daemon configuration](daemon-configuration.md)
- [Logging drivers](logging-drivers.md)
- [cgroups v2](../foundations/cgroups-v2.md)
- [Resources, requests and limits](../k8s-intermediate/resources-requests-limits.md)
- [OOMKilled](../troubleshooting/oomkilled.md)
