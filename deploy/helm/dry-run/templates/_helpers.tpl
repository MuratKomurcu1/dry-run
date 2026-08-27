{{- define "dry-run.name" -}}{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}{{- end }}
{{- define "dry-run.fullname" -}}{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{- else }}{{ printf "%s-%s" .Release.Name (include "dry-run.name" .) | trunc 63 | trimSuffix "-" }}{{- end }}{{- end }}
{{- define "dry-run.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "dry-run.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- define "dry-run.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dry-run.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "dry-run.secretName" -}}{{- default (include "dry-run.fullname" .) .Values.secrets.existingSecret -}}{{- end }}
{{- define "dry-run.claimName" -}}{{- default (include "dry-run.fullname" .) .Values.workspace.existingClaim -}}{{- end }}
