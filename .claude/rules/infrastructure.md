---
paths:
  - "**/Dockerfile*"
  - "**/docker-compose*"
  - "**/*.tf"
  - "**/*.tfvars"
  - "**/helm/**"
  - "**/charts/**"
  - "**/k8s/**"
  - "**/kubernetes/**"
  - "**/infra/**"
  - "**/infrastructure/**"
  - "**/deploy/**"
  - "**/.github/workflows/**"
  - "**/.gitlab-ci.yml"
  - "**/Jenkinsfile"
  - "**/azure-pipelines.yml"
  - "**/.circleci/**"
  - "**/serverless.yml"
  - "**/Procfile"
---

# Infrastructure, CI/CD and Deployment Standards

## Changes

- Everything is declared in the repository: infrastructure-as-code, pipeline definitions and
  config templates. Nothing is changed by hand in a console without being recorded.
- Validate before applying: `terraform plan`, `docker build`, `helm template` / `lint`, a local
  pipeline run or a linter. Record the output in the ledger.
- Pin versions: base images, actions, providers and toolchains. Don't use `latest` in anything
  deployed.
- Environments stay separated. A change for one must not silently affect another.

## Secrets

Secrets come from the platform's secret store and are referenced by name. Never inline a secret in
a pipeline, image layer, manifest or log. Creating, rotating or moving a secret is a gated action.

## Gated

Human approval is required before any of these:

- applying infrastructure changes to shared environments;
- any production deploy or production configuration change;
- deleting or de-provisioning resources;
- changing paid resources or external services.

Plans, dry-runs and local builds need no approval.

## Diagnosing Pipeline and Deployment Failures

1. Read the failing step's actual log output.
2. Establish whether the failure is in code, test, environment, configuration or an external
   service.
3. Reproduce locally where possible.
4. Fix the cause. Never add blanket retries, `continue-on-error` or skipped steps to get green.
