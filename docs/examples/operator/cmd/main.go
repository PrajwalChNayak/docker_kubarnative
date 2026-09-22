// Command manager runs the Tasklane TaskQueue controller.
//
// It is a normal Go binary: it builds a controller-runtime Manager, which owns
// the shared informer cache, the work queues, the leader-election lease, the
// metrics endpoint and the health probes, then blocks until SIGTERM.
package main

import (
	"flag"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	tasklanev1alpha1 "example.com/tasklane-operator/api/v1alpha1"
	"example.com/tasklane-operator/internal/controller"
)

var scheme = runtime.NewScheme()

func init() {
	// The scheme maps Go types to GroupVersionKinds. The client cannot read or
	// write a type that is not registered here.
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(tasklanev1alpha1.AddToScheme(scheme))
}

func main() {
	var metricsAddr, probeAddr string
	var enableLeaderElection bool

	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "address the metrics endpoint binds to")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "address the probe endpoint binds to")
	flag.BoolVar(&enableLeaderElection, "leader-elect", true,
		"run leader election so only one replica reconciles at a time")

	zapOpts := zap.Options{Development: false}
	zapOpts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&zapOpts)))

	setupLog := ctrl.Log.WithName("setup")

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsserver.Options{BindAddress: metricsAddr},
		HealthProbeBindAddress: probeAddr,
		// Leader election uses a Lease in the operator's own namespace. Two
		// replicas may both be running and both have warm caches, but only the
		// lease holder reconciles, so nobody fights over replica counts.
		LeaderElection:   enableLeaderElection,
		LeaderElectionID: "taskqueue.tasklane.example.com",
	})
	if err != nil {
		setupLog.Error(err, "unable to build manager")
		os.Exit(1)
	}

	if err := (&controller.TaskQueueReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Recorder: mgr.GetEventRecorderFor("taskqueue-controller"),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to set up controller", "controller", "TaskQueue")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to add health check")
		os.Exit(1)
	}
	// The readiness check waits for the informer cache to sync, so a replica
	// that has not finished listing is never counted as ready.
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to add ready check")
		os.Exit(1)
	}

	setupLog.Info("starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "manager exited with error")
		os.Exit(1)
	}
}
