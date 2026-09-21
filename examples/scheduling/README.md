# Scheduling examples

Demonstrations for the scheduling pages of Part H: node selection and
affinity, inter-pod affinity, taints and tolerations, topology spread, and
priority and preemption. They are written against the handbook lab: a kind
cluster named `tasklane` running Kubernetes 1.37.0 with one control-plane
node and two workers labelled `topology.kubernetes.io/zone=zone-a` and
`zone-b`, with stages 1 to 4 applied.

Every workload here is a throwaway demo: a pinned `busybox` image running
`sleep` as UID/GID 65534, with the security context the `restricted` Pod
Security Standard requires in the `tasklane` namespace. They exist to make
placement visible, not to do work.

| File | Shows |
|---|---|
| [node-affinity.yaml](node-affinity.yaml) | `nodeSelector`, required and preferred node affinity, weights |
| [pod-anti-affinity.yaml](pod-anti-affinity.yaml) | required anti-affinity per node, `matchLabelKeys`, preferred affinity to the API |
| [taints-tolerations.yaml](taints-tolerations.yaml) | tolerating a `NoSchedule` taint, shortening the node-lifecycle `NoExecute` tolerations |
| [topology-spread.yaml](topology-spread.yaml) | `maxSkew`, `minDomains`, `nodeAffinityPolicy`, `nodeTaintsPolicy`, hard zone spread plus soft node spread |
| [priority-classes.yaml](priority-classes.yaml) | two PriorityClasses, `preemptionPolicy: Never`, a workload that uses one |
| [unschedulable-demo.yaml](unschedulable-demo.yaml) | a pod that can never schedule, for reading `FailedScheduling` events |

## Before you start

Check that the zone labels are there:

```bash
kubectl get nodes -L topology.kubernetes.io/zone
```

## Node affinity

```bash
kubectl apply -f examples/scheduling/node-affinity.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-node-affinity
```

All four replicas are feasible on both workers, and the weight of 80 on
`zone-a` biases scoring towards that worker without forbidding `zone-b`.
Delete the control-plane term or change the zone values to watch replicas
move. `IgnoredDuringExecution` means relabelling a node afterwards does not
move running pods.

## Pod anti-affinity

```bash
kubectl apply -f examples/scheduling/pod-anti-affinity.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-anti-affinity
```

The lab has two schedulable workers and the rule allows one replica per
node, so the third replica stays `Pending`. That is the correct outcome:
required anti-affinity caps your replica count at the number of domains.

```bash
kubectl -n tasklane describe pod -l app.kubernetes.io/name=sched-anti-affinity
```

## Taints and tolerations

Taint a worker, apply the demo, then remove the taint again. The last
command is what keeps the lab reusable, so do not skip it.

```bash
kubectl taint nodes tasklane-worker maintenance=true:NoSchedule
kubectl apply -f examples/scheduling/taints-tolerations.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-toleration
kubectl describe node tasklane-worker | grep -A2 Taints
kubectl taint nodes tasklane-worker maintenance=true:NoSchedule-
```

`NoSchedule` does not evict anything that is already running. Repeat with
`maintenance=true:NoExecute` to see pods without a matching toleration
leave the node, and note that the demo's own `tolerationSeconds: 60` only
applies to the two node-lifecycle taints it names.

## Topology spread

```bash
kubectl apply -f examples/scheduling/topology-spread.yaml
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-spread
```

Four replicas across two zones with `maxSkew: 1` means 2 and 2. Scale to 5
and the hard zone constraint still allows 3/2; scale to 5 after cordoning
one worker and the extra replicas stay `Pending`, because
`whenUnsatisfiable: DoNotSchedule` will not break the skew.

## Priority and preemption

```bash
kubectl apply -f examples/scheduling/priority-classes.yaml
kubectl get priorityclasses
kubectl -n tasklane get pods -o wide -l app.kubernetes.io/name=sched-batch
```

`tasklane-batch` uses `preemptionPolicy: Never`: its pods sort ahead of
priority-0 pods in the scheduling queue but never evict anything. To watch
a real preemption you need a node under pressure, which a two-worker kind
cluster only reaches if you inflate the demo's CPU requests; do that on the
lab, never on a shared cluster.

## Unschedulable pod

```bash
kubectl apply -f examples/scheduling/unschedulable-demo.yaml
kubectl -n tasklane describe pod sched-unschedulable
kubectl delete -f examples/scheduling/unschedulable-demo.yaml
```

The event names the count of nodes rejected by each predicate, which is the
fastest way to learn why a pod is pending.

## Clean up

```bash
kubectl delete -f examples/scheduling/ --ignore-not-found
kubectl taint nodes tasklane-worker maintenance=true:NoSchedule-
```
