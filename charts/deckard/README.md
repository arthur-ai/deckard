# Deckard Helm chart

Runs [Arthur Deckard](../../README.md) as a single pod that scans the sources in your config
on a schedule and sends what it finds to your SIEM or a webhook.

## Install

1. Write `discovery.yaml`, referencing each credential as `${NAME}`:

   ```yaml
   sources:
     - name: vertex-prod
       vendor: gcp_vertex
       fields:
         - {key: project_id, value: my-gcp-project}
         - {key: service_account_key, value: "${GCP_SERVICE_ACCOUNT_KEY}"}
       # ...
   destination:
     type: splunk_hec
     url: https://splunk.example.com:8088/services/collector/event
     token: ${SPLUNK_HEC_TOKEN}
   ```

2. Put those credentials in a Secret named `deckard-credentials`, one key per `${NAME}`:

   ```bash
   kubectl create namespace deckard
   kubectl -n deckard create secret generic deckard-credentials \
     --from-literal=SPLUNK_HEC_TOKEN='<HEC token>' \
     --from-file=GCP_SERVICE_ACCOUNT_KEY=gcp-key.json
   ```

3. Install:

   ```bash
   helm install deckard oci://ghcr.io/arthur-ai/charts/deckard -n deckard \
     --set-file config=discovery.yaml

   kubectl -n deckard logs -f deployment/deckard
   ```

   That installs the newest [release](https://github.com/arthur-ai/deckard/releases);
   add `--version` to pin one. From a clone, `./charts/deckard` in place of the `oci://`
   reference installs that checkout's version.

A config change takes effect on the next `helm upgrade`. A change to the Secret needs
`kubectl -n deckard rollout restart deployment/deckard`.

## Values

| Value | Default | |
|---|---|---|
| `config` | | Your `discovery.yaml`. Required |
| `image.repository` / `image.tag` | `arthurplatform/deckard` / the chart's `appVersion` | The Deckard image of the chart's own version |
| `serviceAccount.annotations` | `{}` | For cloud workload identity, below |
| `resources` | 250m / 512Mi requested, 2Gi memory limit | |
| `nodeSelector` / `tolerations` | `{}` / `[]` | |

## Cloud credentials without keys

A cloud source can use the pod's own identity instead of a key. Annotate the service account
for IRSA or GKE Workload Identity, leave the key out of the source, and add the opt-in for
that source to the credentials Secret (Deckard refuses ambient credentials unless told to):

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/deckard
```

```bash
kubectl -n deckard create secret generic deckard-credentials \
  --from-literal=ARTHUR_ENGINE_AWS_BEDROCK_ALLOW_DEFAULT_CREDENTIALS=true \
  --from-literal=SPLUNK_HEC_TOKEN='<HEC token>'
```

The opt-in for each source is in the
[configuration reference](https://github.com/arthur-ai/arthur-engine/blob/main/ml-engine/docs/standalone-discovery.md#sources).

## What the chart decides for you

- **One replica, `Recreate` strategy.** A second pod would run every scan again and send
  every agent twice.
- **Locked-down pod.** Non-root, read-only root filesystem, no capabilities, no service
  account token. Deckard needs no Kubernetes API access and no inbound traffic, so there is
  no Service.
- **amd64 or arm64 nodes.** The image is built for both, so the chart sets no architecture.
  Deckard 0.1.0 was amd64 only: to run it on a cluster that also has arm64 nodes, set
  `nodeSelector: {kubernetes.io/arch: amd64}`.
- **Credentials come from a Secret named `deckard-credentials`**, which you create. It is
  optional: a config that needs no credentials needs no Secret.
- **The config is stored in a Secret**, in case a credential is written into it directly.
