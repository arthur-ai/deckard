# Deckard sources and destinations: cards for a coding agent

Read by an agent following [prompt.md](prompt.md), Phase 8. Each card lists what to ask the
user, the secrets (which go in `.env` or `secrets/`, prompt step 8.3) and the YAML to add.
Every field and permission is in the
[configuration reference](https://github.com/arthur-ai/arthur-engine/blob/main/ml-engine/docs/standalone-discovery.md).

## Source menu

| # | Source | `vendor` | What Deckard reads |
|---|---|---|---|
| 1 | Google Vertex AI Agent Engine | `gcp_vertex` | Every Agent Engine in one project and region |
| 2 | Google Cloud Run and GKE | `gcp_containers` | Workloads that run an agent's image or call Vertex AI models |
| 3 | AWS Bedrock and AgentCore | `aws_bedrock` | Bedrock agents, AgentCore runtimes, and the IAM roles CloudTrail shows calling Bedrock models |
| 4 | AWS ECS and EKS | `aws_containers` | Workloads that run an agent's image or run as a role calling Bedrock models |
| 5 | Vercel | `vercel_ai` | A team's projects that call an LLM or run an agent |
| 6 | Wiz | `wiz` | AI agents and services, and AI frameworks on workloads, in one Wiz tenant's inventory |
| 7 | Jamf Pro (managed Macs) | `jamf_pro` | The endpoint collector's inventory on each Mac |
| 8 | Google Compute Engine VMs | `gcp_compute_engine` | The endpoint collector's inventory on each VM |
| 9 | AWS EC2 instances | `aws_ec2` | The endpoint collector's inventory on each instance, through SSM |
| 10 | AWS network logs (CloudWatch Logs) | `aws_network` | Route 53 Resolver query logs or VPC flow logs: hosts calling LLM APIs |
| 11 | Google Cloud network logs | `gcp_network` | Cloud DNS query logs and VPC flow logs: workloads calling LLM APIs |
| 12 | Splunk Enterprise | `splunk_enterprise` | The results of the user's SPL search |
| 13 | Elastic Security | `elastic_security` | The results of the user's ES\|QL query |
| 14 | None for now: keep only this machine | | |

Every source's `configs` uses `query: ""` and `query_language: none` unless its card says
otherwise.

### 1. `gcp_vertex`
- **Prerequisites:** a GCP project with Agent Engines; permission to create a service account key.
- **Ask:** project ID (not number); region (default `us-central1`).
- **Secret file:** `secrets/gcp-key.json`, a service-account JSON key with
  `roles/aiplatform.viewer`. Console: IAM & Admin > Service Accounts > Create, grant the
  role, then Keys > Add key > JSON.
```yaml
  - name: vertex-prod
    vendor: gcp_vertex
    fields:
      - {key: project_id, value: <project id>}
      - {key: location, value: <region>}
      - {key: service_account_key, value: {file: secrets/gcp-key.json}}
    configs:
      - {name: agent-engines, query: "", query_language: none, lookback_window_seconds: 21600}
```

### 2. `gcp_containers`
- **Prerequisites:** Cloud Run or GKE in the projects; Deckard must reach each GKE cluster's endpoint.
- **Ask:** project IDs, comma-separated; optionally the regions to list Cloud Run jobs in
  (empty asks every region, which is slow); whether to report every workload, not only
  matches (default no).
- **Secret file:** `secrets/gcp-key.json` with `roles/run.viewer` and `roles/container.viewer`.
  To find workloads by their Vertex AI calls, also `roles/logging.privateLogViewer` and Data
  Access audit logs on for `aiplatform.googleapis.com`.
```yaml
  - name: gcp-workloads
    vendor: gcp_containers
    fields:
      - {key: project_ids, value: "<project-a,project-b>"}
      - {key: service_account_key, value: {file: secrets/gcp-key.json}}
      # - {key: regions, value: "us-central1"}
      # - {key: report_all_workloads, value: "true"}
    configs:
      - {name: workloads, query: "", query_language: none, lookback_window_seconds: 86400}
```

### 3. `aws_bedrock`
- **Prerequisites:** an AWS account using Bedrock; permission to create an IAM user.
- **Ask:** regions, comma-separated; optionally a role ARN to assume and its external ID.
- **Secrets:** `AWS_ACCESS_KEY_ID_DISCOVERY`, `AWS_SECRET_ACCESS_KEY_DISCOVERY`: an IAM
  user's access key, whose policy allows `bedrock:ListAgents`,
  `bedrock-agentcore:ListAgentRuntimes` and `cloudtrail:LookupEvents` on `*`.
```yaml
  - name: bedrock-prod
    vendor: aws_bedrock
    fields:
      - {key: regions, value: "<regions>"}
      - {key: access_key_id, value: "${AWS_ACCESS_KEY_ID_DISCOVERY}"}
      - {key: secret_access_key, value: "${AWS_SECRET_ACCESS_KEY_DISCOVERY}"}
      # - {key: role_arn, value: "arn:aws:iam::123456789012:role/deckard"}
      # - {key: external_id, value: "<external id>"}
    configs:
      - {name: agents-and-callers, query: "", query_language: none, lookback_window_seconds: 21600}
```

### 4. `aws_containers`
- **Prerequisites:** ECS or EKS in the account. For EKS, each cluster needs an access entry
  for Deckard's IAM principal with `AmazonEKSViewPolicy` at cluster scope.
- **Ask:** regions, comma-separated; optionally a role ARN and external ID; whether to report
  every workload (default no).
- **Secrets:** as for `aws_bedrock`, with read-only `ecs:List*`/`ecs:Describe*` (clusters,
  services, tasks, task definitions), `eks:ListClusters`, `eks:DescribeCluster`,
  `eks:ListNodegroups`, `eks:DescribeNodegroup`, `eks:ListPodIdentityAssociations`,
  `eks:DescribePodIdentityAssociation`, `eks:ListFargateProfiles`,
  `eks:DescribeFargateProfile` and `cloudtrail:LookupEvents`. The reference lists the rest.
```yaml
  - name: aws-workloads
    vendor: aws_containers
    fields:
      - {key: regions, value: "<regions>"}
      - {key: access_key_id, value: "${AWS_ACCESS_KEY_ID_DISCOVERY}"}
      - {key: secret_access_key, value: "${AWS_SECRET_ACCESS_KEY_DISCOVERY}"}
      # - {key: report_all_workloads, value: "true"}
    configs:
      - {name: workloads, query: "", query_language: none, lookback_window_seconds: 86400}
```

### 5. `vercel_ai`
- **Prerequisites:** a Vercel team; a team member to create a token as.
- **Ask:** the team ID (`team_...`, Settings > General); optionally project names to limit to.
- **Secret:** `VERCEL_TOKEN`: an access token scoped to that team, with an expiry (Account
  Settings > Tokens). Viewer roles may not see observability data; a Member token can.
```yaml
  - name: vercel
    vendor: vercel_ai
    fields:
      - {key: team_id, value: <team id>}
      - {key: access_token, value: "${VERCEL_TOKEN}"}
      # - {key: include_projects, value: "web,api"}
    configs:
      - {name: projects, query: "", query_language: none, lookback_window_seconds: 86400}
```

### 6. `wiz`
- **Prerequisites:** a Wiz tenant; permission to create a service account.
- **Ask:** the GraphQL endpoint (User Settings > Tenant, `https://api.<dc>.app.wiz.io/graphql`);
  for gov or FedRAMP tenants, `auth_environment` (`gov` or `fedramp`).
- **Secrets:** `WIZ_CLIENT_ID`, `WIZ_CLIENT_SECRET`: a Wiz service account with
  `read:resources` and `read:inventory`.
```yaml
  - name: wiz
    vendor: wiz
    fields:
      - {key: api_endpoint_url, value: "https://api.<dc>.app.wiz.io/graphql"}
      - {key: client_id, value: "${WIZ_CLIENT_ID}"}
      - {key: client_secret, value: "${WIZ_CLIENT_SECRET}"}
    configs:
      - {name: ai-inventory, query: "", query_language: none, lookback_window_seconds: 86400}
```

### 7. `jamf_pro`
- **Prerequisites:** Arthur's endpoint collector deployed to the Macs through Jamf:
  https://github.com/arthur-ai/arthur-engine/blob/main/integrations/endpoint-ai-discovery/docs/mdm/jamf-pro.md
- **Ask:** the Jamf Pro URL (`https://<name>.jamfcloud.com`); optionally computer group
  names, comma-separated.
- **Secrets:** `JAMF_CLIENT_ID`, `JAMF_CLIENT_SECRET`: Settings > System > API roles and
  clients, a role with *Read Computers* (and *Read Smart/Static Computer Groups* for groups),
  then an API client with it, enabled, and Generate client secret.
```yaml
  - name: corp-macs
    vendor: jamf_pro
    fields:
      - {key: base_url, value: "https://<name>.jamfcloud.com"}
      - {key: client_id, value: "${JAMF_CLIENT_ID}"}
      - {key: client_secret, value: "${JAMF_CLIENT_SECRET}"}
      # - {key: include_groups, value: "Engineering,Data Science"}
    configs:
      - {name: all-macs, query: "", query_language: none, lookback_window_seconds: 21600}
```

### 8. `gcp_compute_engine`
- **Prerequisites:** the collector deployed to the VMs through an OS policy:
  https://github.com/arthur-ai/arthur-engine/blob/main/integrations/endpoint-ai-discovery/docs/mdm/gce.md
- **Ask:** exactly one of: project IDs, an organization number, or folder numbers.
- **Secret file:** `secrets/gcp-key.json` with `roles/compute.viewer`; for an organization or
  folder, also `roles/browser`, both granted there.
```yaml
  - name: gce-fleet
    vendor: gcp_compute_engine
    fields:
      - {key: project_ids, value: "<project-a,project-b>"}
      # or: - {key: organization_id, value: "<org number>"}
      # or: - {key: folder_ids, value: "<folder numbers>"}
      - {key: service_account_key, value: {file: secrets/gcp-key.json}}
    configs:
      - {name: vms, query: "", query_language: none, lookback_window_seconds: 86400}
```

### 9. `aws_ec2`
- **Prerequisites:** the collector deployed to the instances through SSM:
  https://github.com/arthur-ai/arthur-engine/blob/main/integrations/endpoint-ai-discovery/docs/mdm/ec2.md
- **Ask:** regions (comma-separated, or `all`); for several accounts, `all` or account IDs
  and the member role name (default `arthur-ai-discovery`).
- **Secrets:** as for `aws_bedrock`, with `ec2:DescribeInstances`,
  `ssm:DescribeInstanceInformation`, `ssm:ListInventoryEntries`, plus `ec2:DescribeRegions`
  for `all`; with `accounts`, `organizations:ListAccounts` and `sts:AssumeRole` on the member role.
```yaml
  - name: ec2-fleet
    vendor: aws_ec2
    fields:
      - {key: regions, value: "<regions or all>"}
      - {key: access_key_id, value: "${AWS_ACCESS_KEY_ID_DISCOVERY}"}
      - {key: secret_access_key, value: "${AWS_SECRET_ACCESS_KEY_DISCOVERY}"}
      # - {key: accounts, value: all}
    configs:
      - {name: instances, query: "", query_language: none, lookback_window_seconds: 86400}
```

### 10. `aws_network`
- **Prerequisites:** Route 53 Resolver query logs or VPC Flow Logs in CloudWatch Logs.
- **Ask:** the region; log group names (up to 20); the format: `route53_resolver_query_log`
  (best: it names the hosts), `vpc_flow_log_v2` (addresses only: matches only the extra
  hosts or CIDRs listed) or `custom` (a regex with named groups `src` and `dest`);
  optionally extra inference hosts, such as an internal LLM gateway.
- **Secrets:** as for `aws_bedrock`, with only `logs:FilterLogEvents` on those log groups.
```yaml
  - name: aws-dns
    vendor: aws_network
    fields:
      - {key: region, value: <region>}
      - {key: log_group_names, value: "<group-a,group-b>"}
      - {key: log_format, value: route53_resolver_query_log}
      - {key: access_key_id, value: "${AWS_ACCESS_KEY_ID_DISCOVERY}"}
      - {key: secret_access_key, value: "${AWS_SECRET_ACCESS_KEY_DISCOVERY}"}
      # - {key: extra_inference_hosts, value: "llm-gateway.internal,10.20.0.0/16"}
    configs:
      - {name: dns, query: "", query_language: none, lookback_window_seconds: 3600}
```

### 11. `gcp_network`
- **Prerequisites:** Cloud DNS logging (a DNS server policy per VPC network) or VPC flow
  logs turned on; neither is by default. Under Shared VPC, use the host project.
- **Ask:** the project ID; optionally extra inference hosts.
- **Secret file:** `secrets/gcp-key.json` with `roles/logging.viewer`.
```yaml
  - name: gcp-dns
    vendor: gcp_network
    fields:
      - {key: project_id, value: <project id>}
      - {key: service_account_key, value: {file: secrets/gcp-key.json}}
      # - {key: extra_inference_hosts, value: "llm-gateway.internal"}
    configs:
      - {name: dns-and-flows, query: "", query_language: none, lookback_window_seconds: 3600}
```

### 12. `splunk_enterprise`
- **Prerequisites:** logs in Splunk that show agents (LLM gateway or proxy logs, say), and
  token authentication on.
- **Ask:** the management URL (`https://<host>:8089`); whether it uses Splunk's default
  certificate (then uncomment the TLS lines and copy its `$SPLUNK_HOME/etc/auth/cacert.pem`
  to `secrets/splunk-ca.pem`); the index and filter to search.
- **Secret:** `SPLUNK_AUTH_TOKEN`: Settings > Tokens > New Token, for a user who can search
  that index.
- **Query:** help the user write SPL whose output columns are only `external_id`, `name`,
  `last_seen` (all required, one row per agent, `external_id` stable forever) and optionally
  `llm_models`, `tools`, `sub_agents`, `data_sources`, `runs_on`, `platform`. Any other
  column fails the scan.
```yaml
  - name: splunk-siem
    vendor: splunk_enterprise
    fields:
      - {key: base_url, value: "https://<host>:8089"}
      - {key: auth_token, value: "${SPLUNK_AUTH_TOKEN}"}
      # - {key: tls_verification, value: ca_only}
      # - {key: ca_certificate, value: {file: secrets/splunk-ca.pem}}
    configs:
      - name: agents
        query_language: spl
        query: |
          search index=<index> <filter>
          | stats max(_time) as last_seen, values(model) as llm_models by consumer
          | eval external_id="<namespace>:" . consumer, name=consumer, last_seen=strftime(last_seen, "%Y-%m-%dT%H:%M:%SZ")
          | table external_id, name, last_seen, llm_models
        lookback_window_seconds: 86400
```

### 13. `elastic_security`
- **Prerequisites:** the logs are in an Elasticsearch reachable over `https://`.
- **Ask:** the Elasticsearch URL (not Kibana's); whether it has a self-signed certificate
  (then `tls_verification: ca_only` and its CA at `secrets/elastic-ca.pem`); the index.
- **Secret:** `ELASTIC_SOURCE_API_KEY`: the `encoded` value of an API key with `read` on
  that index only (Kibana > Stack Management > API keys).
- **Query:** ES|QL with the same columns as Splunk, ending `| LIMIT 10000`. The reference has
  one for Kong Gateway logs.
```yaml
  - name: elastic-siem
    vendor: elastic_security
    fields:
      - {key: elasticsearch_url, value: "https://<host>:9243"}
      - {key: api_key, value: "${ELASTIC_SOURCE_API_KEY}"}
    configs:
      - name: agents
        query_language: esql
        query: |
          FROM <index>
          | STATS last_seen = MAX(@timestamp), llm_models = VALUES(model) BY consumer
          | EVAL external_id = CONCAT("<namespace>:", consumer), name = consumer
          | KEEP external_id, name, last_seen, llm_models
          | LIMIT 10000
        lookback_window_seconds: 86400
```

## Destination menu

Deckard sends to exactly one destination: the card's block replaces the whole
`destination:` block.

| # | Destination | `type` |
|---|---|---|
| 1 | The user's own Elasticsearch or Elastic Security | `elasticsearch` |
| 2 | Splunk HTTP Event Collector (HEC) | `splunk_hec` |
| 3 | Any HTTPS webhook that takes a JSON array | `webhook` |
| 4 | Keep the local Elasticsearch and Kibana | (no change) |
| 5 | Rehearse first: a test webhook on this machine, no credentials | `webhook` |

### 1. `elasticsearch`
- **Ask:** the Elasticsearch URL (`https://`; Elastic Cloud: "Copy endpoint" under
  Elasticsearch); optionally an index (default `logs-arthur.discovery-default`) or pipeline.
- **Secret:** `ELASTIC_API_KEY`: the `encoded` value of a key the user creates in Kibana >
  Dev Tools:
  `POST /_security/api_key {"name": "deckard", "role_descriptors": {"deckard": {"indices": [{"names": ["logs-arthur.discovery-*"], "privileges": ["create_doc", "auto_configure"]}]}}}`
```yaml
destination:
  type: elasticsearch
  url: https://<deployment>.es.<region>.cloud.es.io
  api_key: ${ELASTIC_API_KEY}
```
- **Verify:** in their Kibana, Discover in ES|QL mode:
  `FROM logs-arthur.discovery-* | WHERE event_type == "arthur.discovery.agent" | KEEP @timestamp, agent.name, source.name`

### 2. `splunk_hec`
- **Ask:** the HEC URL ending `/services/collector/event` (Splunk Cloud:
  `https://http-inputs-<stack>.splunkcloud.com/services/collector/event`); optionally an
  index; whether HEC uses Splunk's default certificate (then the TLS lines, CA at
  `secrets/splunk-ca.pem`).
- **Secret:** `SPLUNK_HEC_TOKEN`: Settings > Data inputs > HTTP Event Collector > New Token,
  with Global Settings > All tokens Enabled.
```yaml
destination:
  type: splunk_hec
  url: https://<splunk host>:8088/services/collector/event
  token: ${SPLUNK_HEC_TOKEN}
  # index: ai_inventory
  # tls_verification: ca_only
  # ca_certificate: {file: secrets/splunk-ca.pem}
```
- **Verify:** in Splunk, `index=<index> sourcetype="arthur:discovered_agent"`.

### 3. `webhook`
- **Ask:** the `https://` URL; whether it needs an `Authorization` header.
- **Secret (if so):** `WEBHOOK_TOKEN`.
```yaml
destination:
  type: webhook
  url: https://<host>/<path>
  headers:
    Authorization: "Bearer ${WEBHOOK_TOKEN}"
```
- Drop `headers:` if none is needed. Each request is a `POST` of a JSON array of events.
- **Verify:** the user checks their endpoint received them.

### 4. Keep the local Elasticsearch
Leave `destination:` as it is. **Verify:** run prompt Phase 6 again, and check the new
source appears in the Deckard findings view.

### 5. Rehearsal: a test webhook on this machine
No credentials, and nothing new to download: a receiver runs from Deckard's own image on its
Compose network and prints one line per event.
```bash
cd <DECKARD_DIR>/docker-compose && docker rm -f deckard-test-sink >/dev/null 2>&1; docker compose run -d --name deckard-test-sink --no-deps --entrypoint python deckard -c "$(cat <<'PY'
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        events = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"[]")
        auth = "yes" if self.headers.get("Authorization", "").startswith("Bearer ") else "no"
        for e in events:
            print("EVENT", e.get("event_type"), e.get("source", {}).get("name"), e.get("agent", {}).get("name", "-"), "auth=" + auth, flush=True)
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *args):
        pass
http.server.HTTPServer(("0.0.0.0", 8080), H).serve_forever()
PY
)" && sleep 2 && docker ps --filter name=deckard-test-sink --format '{{.Names}} {{.Status}}'
```
Its token is a throwaway, so you may write it yourself:
```bash
cd <DECKARD_DIR>/docker-compose && { [ -f .env ] || cp .env.template .env; } && chmod 600 .env && sed -i.bak '/^WEBHOOK_TOKEN=/d' .env && rm -f .env.bak && printf "WEBHOOK_TOKEN='rehearsal-%s'\n" "$(date +%s)" >> .env
```
```yaml
destination:
  type: webhook
  url: http://deckard-test-sink:8080/events
  headers:
    Authorization: "Bearer ${WEBHOOK_TOKEN}"
  # Plain HTTP only because the receiver is on Compose's private network.
  allow_insecure_http: true
```
- **Verify:** `docker logs deckard-test-sink` shows `EVENT arthur.discovery.agent ... auth=yes`
  lines and one `EVENT arthur.discovery.scan_outcome` per scan.
- When done, **[ASK USER]** whether to restore the previous destination from the
  `discovery.yaml.bak-*` backup (then prompt step 8.5 again), and remove the receiver:
  `docker rm -f deckard-test-sink`.
