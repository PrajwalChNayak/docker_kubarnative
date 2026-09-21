---
title: Why orchestration
description: What breaks when you run containers on one machine by hand, and which of those problems Kubernetes actually solves.
level: beginner
type: concept
status: current
versions: Kubernetes 1.37
prerequisites:
  - docker-intermediate/compose-fundamentals
---

## Overview

You can run Tasklane today with `docker compose up`. One host, three
containers, a bind-mounted volume for PostgreSQL, ports published on
localhost. It works, and for a single developer it is the right tool.

Orchestration is what you need when that host is no longer enough: when the
machine must be patched without downtime, when one process is not enough to
serve the traffic, when a crashed container has to come back at 03:00 without
anyone being paged, and when three teams deploy to the same fleet. Kubernetes
is one orchestrator, and the one this handbook teaches, but the problems come
first. If you cannot name the problem you have, you cannot tell whether
Kubernetes solved it.

## Why it exists and when to use it

Take the Compose stack and write down what a human has to do for each
failure.

| Failure | What Compose gives you | What you still do by hand |
|---|---|---|
| The API process exits | `restart: unless-stopped` restarts it | Nothing, if the host is healthy |
| The host dies | Nothing | Find another host, re-run the stack, move the DNS record |
| Traffic doubles | `--scale api=4` on one host | Add hosts, distribute containers, reconfigure the load balancer |
| A release is bad | `docker compose up -d` after a revert | Notice it, decide, revert, hope the image is still on the host |
| The host runs out of memory | The kernel OOM-kills something | Choose what dies, find spare capacity |
| A config value changes | Edit `.env`, recreate containers | Repeat on every host, in order |
| The disk fills with old images | `docker system prune` | Remember to do it |

Every entry in the right-hand column is a human loop. Orchestration is the
business of replacing those loops with a control loop: you declare the end
state ("three API replicas, this image, this config, reachable at this
name"), and software makes reality match, continuously, on a pool of machines
rather than one.

That is the whole value proposition. Kubernetes is worth its cost when you
need:

- **Scheduling across many machines.** Placing work on nodes with room for
  it, and re-placing it when a node disappears.
- **Self-healing.** Restarting containers, replacing pods, draining nodes.
- **Declarative rollouts.** A new version replaces the old one gradually,
  with an automatic stop when the new one fails to become healthy.
- **Service discovery and load balancing** that survives pods moving and
  changing IP addresses.
- **A shared, multi-tenant API** so several teams can deploy without
  coordinating through one person's terminal.
- **A common vocabulary for operations.** Probes, resources, rollouts and
  secrets mean the same thing for every workload on the cluster.

It is a poor trade when you have one small service, no on-call rotation, and
no second team. A single VM with systemd, or a managed platform that hides
all of this, will cost far less. Kubernetes is a distributed system that you
now also have to operate, and its failure modes become your failure modes.
The handbook returns to that decision in
[when not to use Kubernetes](../production/when-not-to-use-kubernetes.md) and
prices it in [cost of Kubernetes](../production/cost-of-kubernetes.md).

:::warning The honest cost
A cluster adds an API server, etcd, a scheduler, controllers, a CNI plugin,
DNS, an ingress or Gateway implementation, and an upgrade cadence of three
minor versions a year with roughly fourteen months of patches each. Managed
control planes remove some of that work, not all of it.
:::

## How it works underneath

Kubernetes is not a program that runs your containers. It is an API server
with a database behind it, plus a set of controllers that watch that database
and act. You write an object that says "I want three of these pods"; a
controller notices the difference between three wanted and zero existing, and
creates pods; the scheduler assigns each pod to a node; the kubelet on that
node asks the container runtime to start containers.

Two consequences matter from the first day:

1. **Everything is data.** Deployments, Services, Secrets, even node health,
   are records in the same API. Anything you can do, a controller can do, and
   the permissions system treats them identically.
2. **Nothing is a one-shot command.** `kubectl apply` writes a record. The
   convergence happens afterwards, asynchronously, and it keeps happening.
   Deleting a pod by hand in a Deployment gets you a new pod, not an empty
   slot.

The container runtime is a detail, and a frequently misunderstood one.
Kubernetes talks to runtimes through the **CRI** (Container Runtime
Interface); the lab uses containerd. Images you build with `docker build`
still run fine, because they are OCI images and every CRI runtime consumes
those. The build tool and the cluster runtime are unrelated choices.

:::deprecated Kubernetes does not "run Docker"
Docker Engine is not a CRI runtime, and the shim that used to translate for
it, **dockershim, was removed in Kubernetes 1.24**. If a tutorial says
otherwise, it predates that release. See
[dockershim removal](../migration/dockershim-removal.md) for what changed and
what did not.
:::

## Basic example

The Compose service and its Kubernetes equivalent, side by side. This is the
same Tasklane API, expressed twice.

```yaml title="compose.yaml (fragment)" fragment
services:
  api:
    image: tasklane-api:0.1.0
    deploy:
      replicas: 3
    restart: unless-stopped
    ports:
      - "8080:8080"
```

```yaml include="examples/k8s/basics/20-deployment.yaml"
```

## Explanation

The Compose snippet describes *processes on this host*. The Kubernetes
snippet describes a *desired state for the cluster*, and almost all of the
extra lines exist because more than one machine is involved:

- `selector` says which pods this Deployment owns. On one host, "the
  containers I started" was obvious; in a cluster, ownership is expressed
  with labels.
- `strategy` says how a change is rolled out: `maxSurge: 1` and
  `maxUnavailable: 0` mean the cluster always has three healthy replicas,
  even mid-release.
- `progressDeadlineSeconds` says when a stuck rollout should be declared
  failed instead of retried for ever. Nobody is watching the terminal, so the
  condition has to be recorded in the object.
- The pod template carries a `securityContext`, resource requests, and a
  readiness probe. All three are inputs to scheduling and traffic routing
  decisions that a single host did not have to make.

Nothing here is Kubernetes being baroque for its own sake. Each field answers
a question that only exists once work moves between machines.

## Common patterns

- **Start with a Deployment, a Service and a ConfigMap.** Most stateless web
  applications need nothing else on day one.
- **Keep the build and the deploy separate.** Build an OCI image once, tag it
  immutably, roll it out by changing the tag in a manifest.
- **Let the platform own restarts.** Do not write supervisor scripts inside
  containers; the kubelet already supervises, and two supervisors disagree.
- **Keep state out of the orchestrated tier where you can.** A managed
  database is usually the cheaper answer;
  [StatefulSets](../k8s-intermediate/statefulsets.md) exist for when it is
  not.
- **Treat the cluster as replaceable.** If your manifests are in git and your
  data is in a database you back up, a cluster is a rebuildable artefact.

## Production considerations

- **Three minor releases a year.** A cluster left alone for eighteen months
  is out of support. Plan upgrades before the first deployment, not after
  the first CVE. See [cluster upgrades](../operations/cluster-upgrades.md).
- **Someone runs the control plane.** Either you (kubeadm, k3s) or a cloud
  provider (EKS, GKE, AKS). That decision drives most of your operational
  cost; [managed Kubernetes compared](../production/managed-kubernetes-compared.md)
  lays out the options.
- **Capacity is a resource-request problem, not a node-count problem.**
  Pods without requests schedule badly and evict unpredictably. See
  [resource requests and limits](../k8s-intermediate/resources-requests-limits.md).
- **Orchestration does not give you observability.** Metrics, logs and traces
  are separate systems you also have to run, covered in Part J.

## Security considerations

A cluster is a shared trust boundary. Moving five services from five VMs onto
one cluster means a compromise in one can reach the others unless you
configure otherwise:

- Namespaces are not a security boundary by themselves; they become one when
  combined with RBAC, [Pod Security Admission](../k8s-security/pod-security-standards.md)
  and [NetworkPolicy](../k8s-intermediate/network-policy.md).
- The default network model allows every pod to reach every other pod. That
  is a deliberate design choice, and it is your job to restrict it.
- Every pod that can read the Kubernetes API can read everything its
  ServiceAccount is allowed to read. Tasklane therefore sets
  `automountServiceAccountToken: false` on both workloads.

The [4C model](../k8s-security/4c-model.md) frames this properly in Part I.

## Troubleshooting

At this stage the most common confusion is expecting imperative behaviour
from a declarative system:

- **"I deleted the pod and it came back."** Correct. Delete the Deployment,
  or scale it to zero.
- **"I edited the container with `kubectl exec` and the change vanished."**
  Also correct. Containers are replaced, not repaired.
- **"`kubectl apply` said `configured` but nothing happened."** The object
  changed; the controller acts afterwards. Watch `kubectl rollout status` or
  the object's `status` block.

## Common mistakes

- **Adopting Kubernetes to solve a build problem.** Slow, unreproducible
  builds stay slow and unreproducible inside a cluster.
- **Assuming Kubernetes replaces Docker.** It replaces neither `docker build`
  nor your registry. It replaces `docker run` on a host, and only that.
- **Lifting a Compose file straight in.** Compose concepts such as
  `depends_on` and host bind mounts have no direct equivalent;
  the translation is a design exercise, not a converter run.
- **Running one cluster per service.** The overhead multiplies; namespaces
  and RBAC exist for separation.
- **Believing the migration ends at "it runs".** Probes, resources, rollout
  strategy, backups and monitoring are the actual work.

## Related topics

- [Architecture](architecture.md)
- [Declarative model and reconciliation](declarative-model-and-reconciliation.md)
- [Local clusters](local-clusters.md)
- [Tasklane on Kubernetes](tasklane-on-kubernetes.md)
- [When not to use Kubernetes](../production/when-not-to-use-kubernetes.md)
- [dockershim removal](../migration/dockershim-removal.md)
