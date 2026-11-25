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
{{- if and .Values.hosted (ne .Values.console.baseDomain .Values.console.host) -}}
{{- fail "a hosted engine publishes everything under its own hive name: console.baseDomain must equal console.host (<label>.hives.pragmatic-tech.ai)" -}}
{{- end -}}
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

{{/* The console's TLS Secret: the operator's, or the minted self-signed one. */}}
{{- define "engine.consoleTlsSecret" -}}
{{- if include "engine.selfSigned" . -}}
pragmatic-console-tls
{{- else -}}
{{- required "tls.mode=secret needs tls.secretName (a kubernetes.io/tls Secret in pragmatic-system), or install with --set tls.mode=self-signed" .Values.tls.secretName -}}
{{- end -}}
{{- end -}}

{{/* The release's images (files/images.json, baked by tools/chart-build.ts): { "<app>": { "repository", "digest" } }. */}}
{{- define "engine.images" -}}
{{- $file := .Files.Get "files/images.json" -}}
{{- if not $file -}}
{{- fail "the chart carries no release images (files/images.json): install a published release of the chart" -}}
{{- end -}}
{{- $file -}}
{{- end -}}

{{/* An image by digest: <registry>/<repository>@<digest>. */}}
{{- define "engine.image" -}}
{{- $images := include "engine.images" .root | fromJson -}}
{{- $image := index $images .app -}}
{{- if not $image -}}
{{- fail (printf "the chart's release images name no %s" .app) -}}
{{- end -}}
{{- printf "%s/%s@%s" .root.Values.images.registry $image.repository $image.digest -}}
{{- end -}}

{{- define "engine.hiveLabels" -}}
pragmatic/hive: {{ include "engine.hive" . }}
{{- end -}}

{{/* What a chart object carries so helm uninstall leaves it (a reinstall under the same release name adopts it again). */}}
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

{{/* The hook objects' delete policy: replaced on the next run, removed once the hooks succeeded or one failed. */}}
{{- define "engine.hookObject" -}}
helm.sh/hook: pre-install,pre-upgrade
helm.sh/hook-weight: {{ .weight | quote }}
helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded,hook-failed
{{- end -}}

{{/* A hook Job: kept after a failure, so its log says why (the next run replaces it). */}}
{{- define "engine.hookJob" -}}
helm.sh/hook: pre-install,pre-upgrade
helm.sh/hook-weight: {{ .weight | quote }}
helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
{{- end -}}

{{- define "engine.storageClass" -}}
{{- if .Values.storage.className }}
storageClassName: {{ .Values.storage.className }}
{{- end }}
{{- end -}}

{{/* What the bootstrap steps are told (BootstrapSettings): public values only. */}}
{{- define "engine.bootstrapEnv" -}}
- name: PRAGMATIC_BOOTSTRAP_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
- { name: PRAGMATIC_BOOTSTRAP_IDP_NAMESPACE, value: {{ include "engine.idpName" . | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_LEVEL, value: {{ .Values.level | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_TENANT_ID, value: {{ include "engine.tenant" . | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_TENANT_NAME, value: {{ include "engine.tenantName" . | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_HIVE_ID, value: {{ include "engine.hive" . | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_HIVE_LABEL, value: {{ include "engine.hiveName" . | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_CONSOLE_HOST, value: {{ .Values.console.host | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_BASE_DOMAIN, value: {{ include "engine.baseDomain" . | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_IDP_HOST, value: {{ include "engine.idpHost" . | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_IDP_INTERNAL_HOST, value: {{ include "engine.idpInternalHost" . | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_TLS_MODE, value: {{ .Values.tls.mode | quote }} }
- { name: PRAGMATIC_BOOTSTRAP_TLS_SECRET, value: {{ if include "engine.selfSigned" . }}""{{ else }}{{ include "engine.consoleTlsSecret" . | quote }}{{ end }} }
- { name: PRAGMATIC_BOOTSTRAP_OWNER_EMAIL, value: {{ include "engine.ownerEmail" . | quote }} }
{{- end -}}

{{/* CEL (the hive agent's admission policy, C3.4): field `f` of `a` and of `b` both absent, or both present and equal. */}}
{{- define "engine.celSame" -}}
(has({{ .a }}.{{ .f }}) == has({{ .b }}.{{ .f }}) && (!has({{ .a }}.{{ .f }}) || {{ .a }}.{{ .f }} == {{ .b }}.{{ .f }}))
{{- end -}}

{{/* CEL: the object (`object` or `oldObject`) is managed by the agent, the console or the engine chart. Helm labels what it
     installs `managed-by: Helm` whatever the chart says, so a Helm object counts when its release is in the engine's
     namespace (its ownership annotation). */}}
{{- define "engine.celManaged" -}}
(has({{ . }}.metadata.labels) && 'app.kubernetes.io/managed-by' in {{ . }}.metadata.labels && ({{ . }}.metadata.labels['app.kubernetes.io/managed-by'] in ['pragmatic-hive-agent', 'pragmatic-tenant-admin', 'pragmatic-engine'] || ({{ . }}.metadata.labels['app.kubernetes.io/managed-by'] == 'Helm' && has({{ . }}.metadata.annotations) && 'meta.helm.sh/release-namespace' in {{ . }}.metadata.annotations && {{ . }}.metadata.annotations['meta.helm.sh/release-namespace'] == 'pragmatic-system')))
{{- end -}}

{{/* CEL: a release image by digest (a raw string: RE2). */}}
{{- define "engine.celReleaseImage" -}}
r'^(ghcr\.io|registry\.pragmatic-tech\.ai)/pragmatic-tech-ai/[^@]+@sha256:[a-f0-9]{64}$'
{{- end -}}

{{/* CEL: container `.` is not privileged and adds no capability. */}}
{{- define "engine.celUnprivileged" -}}
(!has({{ . }}.securityContext) || ((!has({{ . }}.securityContext.privileged) || !{{ . }}.securityContext.privileged) && (!has({{ . }}.securityContext.capabilities) || !has({{ . }}.securityContext.capabilities.add) || size({{ . }}.securityContext.capabilities.add) == 0)))
{{- end -}}
