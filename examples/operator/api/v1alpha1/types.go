package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// TaskQueueSpec is the desired state. Everything here is set by the user;
// the controller never writes to spec.
type TaskQueueSpec struct {
	// workers is how many Tasklane worker replicas this queue wants.
	// The bounds are enforced by the API server from the CRD schema, so the
	// controller never has to defend against a negative or absurd value.
	//
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=20
	Workers int32 `json:"workers"`

	// deploymentName is the Deployment, in the same namespace, whose replica
	// count this queue drives. It is immutable: a CEL transition rule on the
	// CRD rejects any update that changes it, so the controller cannot be
	// pointed at a second Deployment and leave the first one scaled up.
	//
	// +kubebuilder:default="tasklane-worker"
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="deploymentName is immutable",messageExpression="'deploymentName is immutable; this TaskQueue already drives ' + oldSelf"
	DeploymentName string `json:"deploymentName,omitempty"`
}

// TaskQueueStatus is observed state. Only the controller writes it, through
// the status subresource.
type TaskQueueStatus struct {
	// conditions follows the standard Kubernetes condition contract. The
	// listType=map/listMapKey=type markers make the API server merge by
	// condition type instead of by array position, so two writers cannot
	// clobber each other's conditions.
	//
	// +listType=map
	// +listMapKey=type
	// +patchStrategy=merge
	// +patchMergeKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`

	// observedGeneration is the .metadata.generation the controller last
	// reconciled. status is stale whenever it is lower than .metadata.generation.
	//
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// readyReplicas mirrors the target Deployment's ready replica count.
	//
	// +optional
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`
}

// TaskQueue asks for a number of Tasklane workers.
//
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=tq
// +kubebuilder:printcolumn:name="Workers",type=integer,JSONPath=`.spec.workers`
// +kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Deployment",type=string,JSONPath=`.spec.deploymentName`,priority=1
// +kubebuilder:printcolumn:name="Status",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type TaskQueue struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   TaskQueueSpec   `json:"spec,omitempty"`
	Status TaskQueueStatus `json:"status,omitempty"`
}

// TaskQueueList is a list of TaskQueue.
//
// +kubebuilder:object:root=true
type TaskQueueList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []TaskQueue `json:"items"`
}

func init() {
	SchemeBuilder.Register(&TaskQueue{}, &TaskQueueList{})
}
