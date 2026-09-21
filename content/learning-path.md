---
title: Learning path
description: The recommended order through the handbook, with effort estimates and a checkpoint at the end of every stage.
level: foundations
type: tutorial
status: current
versions: Kubernetes 1.37, Docker Engine 29, Compose v5, Helm 4
prerequisites: []
---

## Overview

This page orders the whole handbook. Go straight through, or jump to the stage
that matches where you are. Each stage ends with a **checkpoint**: a short list
of things you should be able to do before moving on. If you cannot, re-read the
stage — the next one assumes it.

Effort estimates assume you read actively and run the labs. They are rough. Two
unhurried evenings per stage is a healthy pace; there is no prize for rushing.

Set up the [running-example lab](https://github.com/PrajwalChNayak/docker_kubarnative/tree/main/examples/lab)
once, early. Every hands-on checkpoint uses it.

## Stage 1 — Foundations (about 4–6 hours)

Understand what a container *is* before you run one in anger.

Read [Part A: Foundations](foundations/what-containers-solve.md) end to end,
finishing with the [container-from-scratch](foundations/container-from-scratch.md)
demo.

:::best-practice Checkpoint — you are ready to move on when you can…
- explain the difference between a container and a VM in terms of the kernel;
- name the Linux namespaces and say what each isolates;
- describe what a cgroup v2 controller limits and how;
- trace an image pull and container start from the Docker CLI down to `runc`;
- say what the OCI image, runtime and distribution specs each define.
:::

## Stage 2 — Docker, beginner to intermediate (about 8–12 hours)

Read [Part B](docker-beginner/install-docker.md) then [Part C](docker-intermediate/dockerfile-instructions.md).
Build and run Tasklane with [`docker run`](docker-beginner/tasklane-with-docker-run.md),
then with [Compose](docker-intermediate/tasklane-with-compose.md).

:::best-practice Checkpoint — you can…
- run, inspect, exec into and clean up containers, and read image digests;
- write a multi-stage Dockerfile that is small, non-root and handles signals;
- explain layer caching and order your Dockerfile for it;
- stand up Tasklane with Compose using health-gated `depends_on` and watch mode;
- explain bridge networking, published ports and named volumes.
:::

## Stage 3 — Docker, advanced and security (about 8–10 hours)

Read [Part D](docker-advanced/buildkit-and-buildx.md) and
[Part E](docker-security/container-threat-model.md).

:::best-practice Checkpoint — you can…
- build multi-platform images and use cache and secret mounts correctly;
- sign an image with cosign and generate an SBOM;
- explain why the Docker socket is root-equivalent and avoid mounting it;
- harden a container: drop capabilities, read-only root, no-new-privileges,
  seccomp;
- find a secret accidentally baked into an image layer.
:::

## Stage 4 — Kubernetes, beginner (about 10–14 hours)

Read [Part F](k8s-beginner/why-orchestration.md). Deploy Tasklane to the lab
with [plain manifests](k8s-beginner/tasklane-on-kubernetes.md).

:::best-practice Checkpoint — you can…
- draw the control-plane and node components and say what each does;
- explain reconciliation and what happens end to end on `kubectl apply`;
- create and debug Pods, Deployments, Services, ConfigMaps and Secrets;
- explain what a Secret does and does not protect;
- use `describe`, `logs --previous`, `events`, `exec`, `port-forward` and
  `kubectl debug`.
:::

## Stage 5 — Kubernetes, intermediate (about 12–16 hours)

Read [Part G](k8s-intermediate/probes.md). Add [TLS via Gateway API and
cert-manager](k8s-intermediate/gateway-api-tls-and-traffic.md) and a
[default-deny NetworkPolicy](k8s-intermediate/network-policy.md) to Tasklane.

:::best-practice Checkpoint — you can…
- configure liveness, readiness and startup probes without causing outages;
- set requests and limits and explain QoS classes and throttling;
- run a StatefulSet with persistent storage and understand CSI;
- expose HTTP with Gateway API (GatewayClass, Gateway, HTTPRoute) and TLS;
- write a NetworkPolicy that default-denies and then allows only what is needed.
:::

## Stage 6 — Kubernetes, advanced (about 16–20 hours)

Read [Part H](k8s-advanced/node-selection-and-affinity.md). Package Tasklane
with [Kustomize](k8s-advanced/kustomize.md) and a [Helm 4 chart](k8s-advanced/helm.md),
then deliver it with [GitOps](k8s-advanced/gitops-argo-cd.md).

:::best-practice Checkpoint — you can…
- control scheduling with affinity, taints/tolerations and topology spread;
- autoscale with HPA (and know when to reach for VPA, KEDA or Karpenter);
- package with Helm and Kustomize and say when to use which;
- run a GitOps workflow and a canary rollout;
- extend Kubernetes with a CRD and a simple controller, and with CEL admission
  policy.
:::

## Stage 7 — Security and operations (about 16–20 hours)

Read [Part I: Kubernetes security](k8s-security/4c-model.md) and
[Part J: Observability and operations](operations/metrics-server-and-metrics-api.md).

:::best-practice Checkpoint — you can…
- design least-privilege RBAC and audit it with `kubectl auth can-i`;
- enforce Pod Security Standards and a policy engine;
- manage secrets with encryption at rest and an external secrets store;
- verify image signatures at admission time;
- run Prometheus, write an actionable alert, and define an SLO;
- upgrade a cluster safely, detect deprecated APIs first, and back up and
  restore with Velero.
:::

## Stage 8 — Production and troubleshooting (about 10–14 hours)

Read [Part K: Production](production/managed-kubernetes-compared.md) and
[Part L: Troubleshooting](troubleshooting/method.md). Keep
[Part M: Migration and reference](reference/kubectl-cheat-sheet.md) at hand.

:::best-practice Checkpoint — you can…
- compare EKS, GKE and AKS on what they actually manage;
- work through a production-readiness checklist;
- state honestly when Kubernetes is the wrong tool;
- diagnose CrashLoopBackOff, ImagePullBackOff, Pending, OOMKilled, failing
  probes, empty Services, DNS failures and stuck-terminating namespaces from
  first principles.
:::

## If you are studying for a certification

The [certification map](reference/certification-map.md) links every CKA, CKAD
and CKS curriculum domain to the pages that teach it, so you can use this book
as a structured study guide.

## Common mistakes

- **Treating the checkpoints as optional.** They are the point. The book is
  built so each stage stands on the one before; a shaky Stage 4 makes Stage 7
  feel like magic incantations.
- **Reading without the lab running.** The mechanism explanations land far
  harder when you can watch the objects change with `kubectl get -w`.

## Related topics

- [Handbook home](index.md)
- [The running example and lab](https://github.com/PrajwalChNayak/docker_kubarnative/tree/main/examples)
- [Coverage map](reference/coverage-map.md)
