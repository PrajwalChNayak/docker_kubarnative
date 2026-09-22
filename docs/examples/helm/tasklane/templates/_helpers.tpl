{{/*
Chart name, overridable.
*/}}
{{- define "tasklane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified release name. Kubernetes names are limited to 63 characters
and DNS-1123, so every generated name is truncated.
*/}}
{{- define "tasklane.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "tasklane.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Labels every object carries. app.kubernetes.io/managed-by: Helm is what
`helm get`/`helm uninstall` and many dashboards key on.
*/}}
{{- define "tasklane.labels" -}}
helm.sh/chart: {{ include "tasklane.chart" . }}
app.kubernetes.io/part-of: tasklane
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Per-component label sets: the common labels plus the component's identity.
These go on metadata and on pod templates. They are a superset of the selector
labels below, which is what lets the selector keep matching.
*/}}
{{- define "tasklane.api.labels" -}}
{{ include "tasklane.labels" . }}
app.kubernetes.io/name: tasklane-api
app.kubernetes.io/component: api
{{- end }}

{{- define "tasklane.worker.labels" -}}
{{ include "tasklane.labels" . }}
app.kubernetes.io/name: tasklane-worker
app.kubernetes.io/component: worker
{{- end }}

{{- define "tasklane.postgres.labels" -}}
{{ include "tasklane.labels" . }}
app.kubernetes.io/name: postgres
app.kubernetes.io/component: database
{{- end }}

{{/*
Selector labels per component. These must never change for a live release:
Deployment and StatefulSet .spec.selector is immutable.
*/}}
{{- define "tasklane.api.selectorLabels" -}}
app.kubernetes.io/name: tasklane-api
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "tasklane.worker.selectorLabels" -}}
app.kubernetes.io/name: tasklane-worker
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "tasklane.postgres.selectorLabels" -}}
app.kubernetes.io/name: postgres
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Object names.
*/}}
{{- define "tasklane.api.fullname" -}}
{{- printf "%s-api" (include "tasklane.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tasklane.worker.fullname" -}}
{{- printf "%s-worker" (include "tasklane.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tasklane.postgres.fullname" -}}
{{- printf "%s-postgres" (include "tasklane.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Image reference. Takes a dict with repository, tag and digest; a digest wins
over a tag, because a digest is the only immutable reference.
*/}}
{{- define "tasklane.image" -}}
{{- if .digest -}}
{{ .repository }}@{{ .digest }}
{{- else -}}
{{ .repository }}:{{ .tag }}
{{- end -}}
{{- end }}

{{/*
Where the database lives: the in-chart StatefulSet's Service unless the
operator set database.host.
*/}}
{{- define "tasklane.dbHost" -}}
{{- if .Values.database.host -}}
{{ .Values.database.host }}
{{- else if .Values.postgresql.enabled -}}
{{ include "tasklane.postgres.fullname" . }}
{{- else -}}
{{ fail "database.host must be set when postgresql.enabled is false" }}
{{- end -}}
{{- end }}

{{/*
Pod-level securityContext for the Go workloads (distroless, UID 65532).
*/}}
{{- define "tasklane.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/*
Container-level securityContext shared by every container in this chart.
*/}}
{{- define "tasklane.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/*
The projected database password, mounted as a file rather than an env var so
it never shows up in `kubectl describe pod` or a crash dump of the process
environment.
*/}}
{{- define "tasklane.dbSecretVolume" -}}
- name: db-secret
  secret:
    secretName: {{ .Values.database.existingSecret }}
    items:
      - key: {{ .Values.database.existingSecretKey }}
        path: password
{{- end }}
