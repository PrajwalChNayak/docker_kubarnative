// Package v1alpha1 contains the tasklane.example.com/v1alpha1 API types.
//
// +kubebuilder:object:generate=true
// +groupName=tasklane.example.com
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	// GroupVersion is the group and version this package serves.
	GroupVersion = schema.GroupVersion{Group: "tasklane.example.com", Version: "v1alpha1"}

	// SchemeBuilder registers the types in this package with a runtime.Scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

	// AddToScheme adds the types in this package to a runtime.Scheme.
	AddToScheme = SchemeBuilder.AddToScheme
)
