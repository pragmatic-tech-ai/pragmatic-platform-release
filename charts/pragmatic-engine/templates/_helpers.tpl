{{/*
The engine's names. They are the ones the console code addresses (K8sManifestBuilder in pragmatic-tenant-plane): the
console Deployment pragmatic-tenant-admin-<tenant>, the realm sign-in service pragmatic-idp-<tenant> in its own namespace,
the hive agent pragmatic-hive-<hive>-agent, all in pragmatic-system.
*/}}

{{- define "engine.namespace" -}}
{{- if ne .Release.Namespace "pragmatic-system" -}}
{{- fail "install pragmatic-engine into the namespace pragmatic-system (--namespace pragmatic-system --create-namespace)" -}}
{{- end -}}
{{- .Release.Namespace -}}
{{- end -}}

{{- define "engine.tenant" -}}{{ .Values.tenant.id }}{{- end -}}
{{- define "engine.tenantName" -}}{{ default .Values.tenant.id .Values.tenant.name }}{{- end -}}
{{- define "engine.hive" -}}{{ default (printf "%s-hive" .Values.tenant.id) .Values.hive.id }}{{- end -}}
{{- define "engine.hiveName" -}}{{ default (include "engine.hive" .) .Values.hive.name }}{{- end -}}
{{- define "engine.standalone" -}}{{ if eq .Values.level "standalone" }}true{{ end }}{{- end -}}
{{- define "engine.selfSigned" -}}{{ if eq .Values.tls.mode "self-signed" }}true{{ end }}{{- end -}}

{{- define "engine.baseDomain" -}}
{{- if .Values.console.baseDomain -}}
{{- .Values.console.baseDomain -}}
{{- else -}}
{{- $parts := splitList "." .Values.console.host -}}
{{- if lt (len $parts) 3 -}}
{{- fail "console.host has no parent domain to publish the sign-in service and the environments under: set console.baseDomain" -}}
{{- end -}}
{{- join "." (rest $parts) -}}
{{- end -}}
{{- end -}}

{{- define "engine.ownerEmail" -}}{{ default (printf "owner@%s" (include "engine.baseDomain" .)) .Values.owner.email }}{{- end -}}
{{- define "engine.portSuffix" -}}{{ if ne (int .Values.console.port) 443 }}:{{ .Values.console.port }}{{ end }}{{- end -}}

{{- define "engine.consoleName" -}}pragmatic-tenant-admin-{{ include "engine.tenant" . }}{{- end -}}
{{- define "engine.idpName" -}}pragmatic-idp-{{ include "engine.tenant" . }}{{- end -}}
{{- define "engine.idpHost" -}}idp-{{ include "engine.tenant" . }}.{{ include "engine.baseDomain" . }}{{- end -}}
{{- define "engine.idpInternalHost" -}}{{ include "engine.idpName" . }}.{{ include "engine.idpName" . }}.svc.cluster.local{{- end -}}
{{- define "engine.idpInternalUrl" -}}https://{{ include "engine.idpInternalHost" . }}:9443{{- end -}}
{{- define "engine.idpBrowserUrl" -}}https://{{ include "engine.idpHost" . }}{{ include "engine.portSuffix" . }}{{- end -}}
{{- define "engine.agentName" -}}pragmatic-hive-{{ include "engine.hive" . }}-agent{{- end -}}
{{- define "engine.agentTokenSecret" -}}pragmatic-hive-{{ include "engine.hive" . }}-agent-token{{- end -}}
{{- define "engine.postgresHost" -}}pragmatic-postgres.{{ include "engine.namespace" . }}.svc{{- end -}}

{{/* The console's TLS Secret: the operator's, or the minted self-signed one. */}}
{{- define "engine.consoleTlsSecret" -}}
{{- if include "engine.selfSigned" . -}}
pragmatic-console-tls
{{- else -}}
{{- required "tls.mode=secret needs tls.secretName (a kubernetes.io/tls Secret in pragmatic-system), or install with --set tls.mode=self-signed" .Values.tls.secretName -}}
{{- end -}}
{{- end -}}

{{/* An image by digest: <registry>/<repository>@<digest>. */}}
{{- define "engine.image" -}}
{{- $image := index .root.Values.images.apps .app -}}
{{- if hasPrefix "sha256:0000000000000000" $image.digest -}}
{{- fail (printf "images.apps.%s has no release digest: install a published release of the chart" .app) -}}
{{- end -}}
{{- printf "%s/%s@%s" .root.Values.images.registry $image.repository $image.digest -}}
{{- end -}}

{{- define "engine.hiveLabels" -}}
pragmatic/hive: {{ include "engine.hive" . }}
{{- end -}}

{{/* What a minted or kept object carries so helm uninstall leaves it. */}}
{{- define "engine.keep" -}}
helm.sh/resource-policy: keep
{{- end -}}

{{/* The labels the console finds a configurable component by (ComponentConfigurationMounts.Attach). */}}
{{- define "engine.componentLabels" -}}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/managed-by: pragmatic-tenant-admin
component.pragmatic-tech.ai/{{ .component }}: {{ .container }}
{{- end -}}

{{/* A non-root, read-only, RuntimeDefault container. */}}
{{- define "engine.containerSecurity" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "engine.podSecurity" -}}
runAsNonRoot: true
fsGroup: {{ .uid }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* The configuration volumes of one component (ComponentConfigurationMounts): its applied configuration, its secret store
and the runtime folder the start step writes configured secrets into. */}}
{{- define "engine.configurationVolumes" -}}
- name: cfg-{{ .short }}
  configMap:
    name: pragmatic-config-{{ .component }}
    optional: true
- name: cfgstore-{{ .short }}
  secret:
    secretName: pragmatic-secrets-{{ .component }}
    optional: true
    defaultMode: 288
- name: cfgrun-{{ .short }}
  emptyDir:
    medium: Memory
    sizeLimit: 4Mi
{{- end -}}

{{- define "engine.configurationMounts" -}}
- name: cfg-{{ .short }}
  mountPath: /etc/pragmatic/configuration
  readOnly: true
- name: cfgstore-{{ .short }}
  mountPath: /run/secrets/pragmatic/{{ .component }}
  readOnly: true
- name: cfgrun-{{ .short }}
  mountPath: /run/pragmatic/secrets
{{- end -}}

{{- define "engine.ingressClass" -}}
{{- if .Values.ingress.className }}
ingressClassName: {{ .Values.ingress.className }}
{{- end }}
{{- end -}}

{{- define "engine.storageClass" -}}
{{- if .Values.storage.className }}
storageClassName: {{ .Values.storage.className }}
{{- end }}
{{- end -}}
