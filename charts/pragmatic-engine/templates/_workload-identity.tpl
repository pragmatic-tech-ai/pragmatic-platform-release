{{/*
The realm secrets home (2.5): where every engine component resolves secret:realm/<name>. realmSecrets.option custom keeps
the realm's secrets in this hive's pragmatic-postgres (database realm_secrets, sealed under pragmatic-realm-master-key, the
console and the sign-in service writing); gcp, azure and aws reach the cloud's secrets service by workload identity only: a
projected service-account token with the cloud's audience, exchanged by the component for short-lived credentials. The
values carry identifiers only (values.schema.json refuses anything else); no cloud key exists in the cluster or the chart.
The console renders the same settings into every environment's server (EnvironmentRealmSecrets).
*/}}

{{- define "engine.realmSecrets.cloud" -}}{{ if ne .Values.realmSecrets.option "custom" }}true{{ end }}{{- end -}}

{{/* The projected token's audience: the pool provider on GCP, Entra's token exchange on Azure, STS on AWS. */}}
{{- define "engine.realmSecrets.audience" -}}
{{- $o := .Values.realmSecrets.option -}}
{{- if eq $o "gcp" -}}
{{- required "realmSecrets.option=gcp needs realmSecrets.gcp.workloadIdentityAudience (//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>)" .Values.realmSecrets.gcp.workloadIdentityAudience -}}
{{- else if eq $o "azure" -}}
api://AzureADTokenExchange
{{- else if eq $o "aws" -}}
sts.amazonaws.com
{{- end -}}
{{- end -}}

{{/* The option's identifiers as PRAGMATIC_REALM_SECRETS_<SETTING> (RealmSecretsSettings), the required ones checked. */}}
{{- define "engine.realmSecrets.settings" -}}
{{- $o := .Values.realmSecrets.option -}}
{{- if eq $o "gcp" -}}
{{- $g := .Values.realmSecrets.gcp }}
- { name: PRAGMATIC_REALM_SECRETS_PROJECT_ID, value: {{ required "realmSecrets.option=gcp needs realmSecrets.gcp.projectId" $g.projectId | quote }} }
- { name: PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE, value: {{ include "engine.realmSecrets.audience" . | quote }} }
{{- if $g.serviceAccountEmail }}
- { name: PRAGMATIC_REALM_SECRETS_SERVICE_ACCOUNT_EMAIL, value: {{ $g.serviceAccountEmail | quote }} }
{{- end }}
{{- if $g.replicaLocation }}
- { name: PRAGMATIC_REALM_SECRETS_REPLICA_LOCATION, value: {{ $g.replicaLocation | quote }} }
{{- end }}
{{- else if eq $o "azure" -}}
{{- $a := .Values.realmSecrets.azure }}
- { name: PRAGMATIC_REALM_SECRETS_TENANT_ID, value: {{ required "realmSecrets.option=azure needs realmSecrets.azure.tenantId" $a.tenantId | quote }} }
- { name: PRAGMATIC_REALM_SECRETS_CLIENT_ID, value: {{ required "realmSecrets.option=azure needs realmSecrets.azure.clientId" $a.clientId | quote }} }
- { name: PRAGMATIC_REALM_SECRETS_VAULT_URL, value: {{ required "realmSecrets.option=azure needs realmSecrets.azure.vaultUrl" $a.vaultUrl | quote }} }
{{- if $a.authorityHost }}
- { name: PRAGMATIC_REALM_SECRETS_AUTHORITY_HOST, value: {{ $a.authorityHost | quote }} }
{{- end }}
{{- else if eq $o "aws" -}}
{{- $w := .Values.realmSecrets.aws }}
- { name: PRAGMATIC_REALM_SECRETS_REGION, value: {{ required "realmSecrets.option=aws needs realmSecrets.aws.region" $w.region | quote }} }
- { name: PRAGMATIC_REALM_SECRETS_ROLE_ARN, value: {{ required "realmSecrets.option=aws needs realmSecrets.aws.roleArn" $w.roleArn | quote }} }
{{- if $w.sessionName }}
- { name: PRAGMATIC_REALM_SECRETS_SESSION_NAME, value: {{ $w.sessionName | quote }} }
{{- end }}
{{- end -}}
{{- end -}}

{{/*
A component's realm secrets variables. (dict "root" . "component" "<name>"): the option, its identifiers (cloud) or its
custom home files (writer: the console and the sign-in service are the home's two writers), the realm (the tenant id, the
same for every component) and the component; the token file for a cloud option.
*/}}
{{- define "engine.realmSecrets.env" -}}
- { name: PRAGMATIC_REALM_SECRETS_OPTION, value: {{ .root.Values.realmSecrets.option | quote }} }
{{- if include "engine.realmSecrets.cloud" .root }}
{{- include "engine.realmSecrets.settings" .root }}
{{- else }}
- { name: PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE, value: /run/secrets/pragmatic-realm-secrets/database-url }
- { name: PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE, value: /run/secrets/pragmatic-realm-master-key/master.key }
- { name: PRAGMATIC_REALM_SECRETS_ACCESS, value: writer }
{{- end }}
- { name: PRAGMATIC_REALM_ID, value: {{ include "engine.tenant" .root | quote }} }
- { name: PRAGMATIC_COMPONENT, value: {{ .component | quote }} }
{{- if include "engine.realmSecrets.cloud" .root }}
- { name: PRAGMATIC_WORKLOAD_TOKEN_FILE, value: /var/run/secrets/pragmatic/workload-identity/token }
{{- end }}
{{- end -}}

{{- define "engine.realmSecrets.mounts" -}}
{{- if include "engine.realmSecrets.cloud" . }}
- { name: realm-workload-identity, mountPath: /var/run/secrets/pragmatic/workload-identity, readOnly: true }
{{- else }}
- { name: realm-secrets-database, mountPath: /run/secrets/pragmatic-realm-secrets, readOnly: true }
- { name: realm-master-key, mountPath: /run/secrets/pragmatic-realm-master-key, readOnly: true }
{{- end }}
{{- end -}}

{{/* (dict "root" . "databaseSecret" "<the component's realm_secrets URL Secret>"). */}}
{{- define "engine.realmSecrets.volumes" -}}
{{- if include "engine.realmSecrets.cloud" .root }}
- name: realm-workload-identity
  projected:
    defaultMode: 288
    sources:
      - serviceAccountToken:
          audience: {{ include "engine.realmSecrets.audience" .root | quote }}
          expirationSeconds: 3600
          path: token
{{- else }}
- name: realm-secrets-database
  secret: { secretName: {{ .databaseSecret }}, defaultMode: 288, items: [{ key: database-url, path: database-url }] }
- name: realm-master-key
  secret: { secretName: pragmatic-realm-master-key, defaultMode: 288, items: [{ key: master.key, path: master.key }] }
{{- end }}
{{- end -}}
