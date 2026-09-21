// Package controller holds the TaskQueue reconciler.
//
// The whole operator is one level-triggered loop: read the TaskQueue, read the
// Deployment it names, make the Deployment's replica count match, write status.
// It never remembers anything between invocations, so replaying the same event
// twice is harmless.
package controller

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	tasklanev1alpha1 "example.com/tasklane-operator/api/v1alpha1"
)

const (
	// conditionReady is the one condition this operator publishes.
	conditionReady = "Ready"

	// defaultDeploymentName matches the CRD default, so the controller still
	// behaves if it ever sees an object written before the default existed.
	defaultDeploymentName = "tasklane-worker"
)

// TaskQueueReconciler reconciles a TaskQueue against the Deployment it names.
type TaskQueueReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
}

// Reconcile is level-triggered: it is handed a name, not an event, and it
// works only from the current state of the API objects. Every path through it
// is idempotent.
func (r *TaskQueueReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var queue tasklanev1alpha1.TaskQueue
	if err := r.Get(ctx, req.NamespacedName, &queue); err != nil {
		// NotFound means the object is gone. There is nothing to clean up:
		// this operator owns no state outside the cluster and sets no
		// ownerReferences, which is exactly why it needs no finalizer.
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Work on a copy so the status diff at the end is against what we read.
	observed := queue.Status.DeepCopy()

	name := queue.Spec.DeploymentName
	if name == "" {
		name = defaultDeploymentName
	}

	var deploy appsv1.Deployment
	err := r.Get(ctx, types.NamespacedName{Namespace: queue.Namespace, Name: name}, &deploy)
	switch {
	case apierrors.IsNotFound(err):
		// Not an error worth retrying with backoff: the Deployment watch below
		// re-enqueues this TaskQueue the moment the Deployment appears.
		meta.SetStatusCondition(&queue.Status.Conditions, metav1.Condition{
			Type:               conditionReady,
			Status:             metav1.ConditionFalse,
			Reason:             "DeploymentNotFound",
			Message:            fmt.Sprintf("Deployment %q does not exist in namespace %q", name, queue.Namespace),
			ObservedGeneration: queue.Generation,
		})
		queue.Status.ReadyReplicas = 0
		queue.Status.ObservedGeneration = queue.Generation
		return ctrl.Result{}, r.writeStatus(ctx, &queue, observed)
	case err != nil:
		return ctrl.Result{}, fmt.Errorf("reading Deployment %s/%s: %w", queue.Namespace, name, err)
	}

	// --- the one write to the world -----------------------------------------
	// The Deployment is patched, not owned. Tasklane's worker Deployment is
	// written by the platform team's GitOps repo; an ownerReference would make
	// the garbage collector delete it when the TaskQueue is deleted, and taking
	// ownership of the whole spec would fight that repo on every other field.
	// A merge patch touches exactly one field and leaves the rest alone.
	desired := queue.Spec.Workers
	current := int32(0)
	if deploy.Spec.Replicas != nil {
		current = *deploy.Spec.Replicas
	}
	if current != desired {
		patch := client.MergeFrom(deploy.DeepCopy())
		deploy.Spec.Replicas = &desired
		if err := r.Patch(ctx, &deploy, patch); err != nil {
			// The patch carries the resourceVersion we read, so a concurrent
			// writer makes this fail with a conflict. Returning the error
			// re-queues with rate-limited backoff and we read fresh state.
			return ctrl.Result{}, fmt.Errorf("patching Deployment %s/%s: %w", deploy.Namespace, deploy.Name, err)
		}
		log.Info("scaled worker Deployment", "deployment", deploy.Name, "from", current, "to", desired)
		if r.Recorder != nil {
			r.Recorder.Eventf(&queue, corev1.EventTypeNormal, "Scaled",
				"Set %s/%s replicas from %d to %d", deploy.Namespace, deploy.Name, current, desired)
		}
	}

	// --- status --------------------------------------------------------------
	queue.Status.ReadyReplicas = deploy.Status.ReadyReplicas
	queue.Status.ObservedGeneration = queue.Generation

	ready := metav1.ConditionFalse
	reason := "ScalingInProgress"
	message := fmt.Sprintf("%d/%d workers ready", deploy.Status.ReadyReplicas, desired)
	if deploy.Status.ReadyReplicas == desired {
		ready = metav1.ConditionTrue
		reason = "AllWorkersReady"
	}
	meta.SetStatusCondition(&queue.Status.Conditions, metav1.Condition{
		Type:               conditionReady,
		Status:             ready,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: queue.Generation,
	})

	return ctrl.Result{}, r.writeStatus(ctx, &queue, observed)
}

// writeStatus issues a status update only when something actually changed.
// Writing an identical status on every pass would bump resourceVersion, wake
// the watch, and reconcile again forever: a hot loop that looks like a bug in
// the API server rather than in the operator.
func (r *TaskQueueReconciler) writeStatus(ctx context.Context, queue *tasklanev1alpha1.TaskQueue, observed *tasklanev1alpha1.TaskQueueStatus) error {
	if equality.Semantic.DeepEqual(*observed, queue.Status) {
		return nil
	}
	if err := r.Status().Update(ctx, queue); err != nil {
		return fmt.Errorf("updating TaskQueue status %s/%s: %w", queue.Namespace, queue.Name, err)
	}
	return nil
}

// SetupWithManager wires the controller into the manager's shared cache.
func (r *TaskQueueReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&tasklanev1alpha1.TaskQueue{}).
		// Watch Deployments too, and map each one back to the TaskQueues that
		// name it. Without this the operator would only notice a hand-edited
		// replica count on its next resync, minutes later.
		Watches(&appsv1.Deployment{}, handler.EnqueueRequestsFromMapFunc(r.taskQueuesForDeployment)).
		Named("taskqueue").
		Complete(r)
}

// taskQueuesForDeployment answers "which TaskQueues care about this
// Deployment?". It reads from the shared informer cache, not the API server.
func (r *TaskQueueReconciler) taskQueuesForDeployment(ctx context.Context, obj client.Object) []reconcile.Request {
	var queues tasklanev1alpha1.TaskQueueList
	if err := r.List(ctx, &queues, client.InNamespace(obj.GetNamespace())); err != nil {
		logf.FromContext(ctx).Error(err, "listing TaskQueues for Deployment", "deployment", obj.GetName())
		return nil
	}

	var requests []reconcile.Request
	for i := range queues.Items {
		name := queues.Items[i].Spec.DeploymentName
		if name == "" {
			name = defaultDeploymentName
		}
		if name != obj.GetName() {
			continue
		}
		requests = append(requests, reconcile.Request{
			NamespacedName: types.NamespacedName{
				Namespace: queues.Items[i].Namespace,
				Name:      queues.Items[i].Name,
			},
		})
	}
	return requests
}
