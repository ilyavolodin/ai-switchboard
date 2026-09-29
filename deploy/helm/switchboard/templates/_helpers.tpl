{{- define "switchboard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "switchboard.fullname" -}}
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

{{- define "switchboard.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "switchboard.labels" -}}
helm.sh/chart: {{ include "switchboard.chart" . }}
{{ include "switchboard.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "switchboard.selectorLabels" -}}
app.kubernetes.io/name: {{ include "switchboard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "switchboard.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "switchboard.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "switchboard.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) }}
{{- end }}

{{/* A map as "k1=v1,k2=v2" (OTEL_RESOURCE_ATTRIBUTES), keys sorted. */}}
{{- define "switchboard.keyValueList" -}}
{{- $pairs := list }}
{{- range $k, $v := . }}
{{- $pairs = append $pairs (printf "%s=%s" $k (toString $v)) }}
{{- end }}
{{- join "," $pairs }}
{{- end }}
