# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities in Arthur Deckard privately. Do not open a public GitHub
issue, discussion or pull request for a suspected vulnerability.

- Use GitHub's [private vulnerability reporting](https://github.com/arthur-ai/deckard/security/advisories/new), or
- email **oss-security@arthur.ai**.

Include as much of the following as you can:

- the affected part (the Helm chart, the Docker Compose setup, or Deckard itself) and the
  image tag or chart version;
- steps to reproduce, or a proof of concept;
- the impact you expect (for example, a source credential or destination token exposed in a
  log, an event, or a Kubernetes object).

We will acknowledge your report, keep you updated while we investigate, and credit you in the
advisory if you would like.

Deckard runs the [Arthur Engine](https://github.com/arthur-ai/arthur-engine)'s ML Engine. A
vulnerability in the engine itself is fixed there; reporting it here or there reaches the
same team.

## Disclosure

We fix confirmed vulnerabilities privately, release the fix, and then publish a GitHub security
advisory for issues that affect released versions. We aim to fix critical and high severity issues
within 90 days of a confirmed report, and ask reporters to keep details private until the advisory
is published.

## Supported versions

We recommend running the latest release of the chart and image.
