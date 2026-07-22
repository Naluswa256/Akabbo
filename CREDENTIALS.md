# Credentials & verification guide

> Phase 0 (skeleton), Phase 1 (identity + ledger), and Phase 2 (AI capture) are
> all built and verified locally. This file lists what I need from you to verify
> the parts that require external accounts: a **DB** (Phase 0/1), **GCP** (Phase 0
> staging deploy), and an **LLM key** (Phase 2 LLM tier). The deterministic
> capture tier already works with no key.

---

## Phase 2 — LLM key (to verify the AI's LLM tier)

The capture layer is tiered: a deterministic parser handles well-shaped
utterances at **$0** (already verified), and the LLM handles the rest. To turn
the LLM tier on:

1. **Pick a key.** Primary is **Gemini 2.5 Flash**; Claude Haiku is the fallback.
   - Gemini: create a key at <https://aistudio.google.com/apikey>.
   - (Optional) Claude fallback: an Anthropic API key from the Anthropic Console.
2. **Set env and flip the selector:**
   ```
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=...            # required to enable the real tier
   ANTHROPIC_API_KEY=...         # optional; appended as fallback if present
   ```
   Models default to `gemini-2.5-flash` / `claude-haiku-4-5` (override via
   `GEMINI_MODEL` / `ANTHROPIC_MODEL`).

**→ give me:** a `GEMINI_API_KEY` (and optionally `ANTHROPIC_API_KEY`).

**What I'll do:** boot with `LLM_PROVIDER=gemini`, send an unshaped utterance
(e.g. *"put down that Peter fellow's promise, think it's about one and a half
million"*), confirm it escalates to the LLM, returns a valid tool call, records a
`usage_event` (tokens + cost + model), and — on low confidence — lands in
`pending_confirmation` for you to confirm. Cost is a fraction of a cent per turn.

Security note: the LLM tiers use no-training/zero-retention expectations
(blueprint §10) — I won't send PII beyond the single utterance, and phone numbers
never enter prompts.

---

# Phase 0 verification — what I need from you

This is the checklist to take Phase 0 from "green locally" to "deployed to Cloud Run
staging, health check passing" (the final DoD box). Work top to bottom. Anything
marked **→ give me** is a value you hand back so I can finish verification.

There are **two verification depths** — pick based on how far you want to go now:

- **A. Local + CI verification** (fastest): I only need **one Postgres connection
  string** (a Neon branch). I run lint/typecheck/test/build, apply the migration, and
  boot both processes against it. No GCP needed.
- **B. Full staging deploy**: everything in A, plus GCP + GitHub so the
  `deploy-staging` workflow builds the image and deploys the api + worker to Cloud Run.

> Security note: paste connection strings / keys to me directly if you want me to run
> commands locally, **or** put them straight into Neon/GCP/GitHub yourself and just
> confirm the names match. Never commit them — `.env` and all secrets are gitignored.

---

## 1. Neon (Postgres) — required for A and B

1. Create a Neon account/project at <https://console.neon.tech>.
   - **Region:** choose **AWS `eu-central-1` (Frankfurt)** or **`eu-west-1` (Ireland)**
     — per the blueprint we run in the EU, not on-continent. Pick one and stay.
   - **Database name:** `akabbo`.
2. Create a branch for staging (Neon → Branches → `New branch` → name it `staging`).
   The default `main` branch is fine too if you'd rather keep one.
3. From the project dashboard → **Connection Details**, copy **two** strings:
   - **Pooled** (the host contains `-pooler`) — used by the app at runtime.
   - **Direct** (untick "Pooled connection") — used by `prisma migrate`.
   Both must end with `?sslmode=require`.

**→ give me:**
```
DATABASE_URL = postgresql://<user>:<pass>@ep-xxxx-pooler.eu-central-1.aws.neon.tech/akabbo?sslmode=require
DIRECT_URL   = postgresql://<user>:<pass>@ep-xxxx.eu-central-1.aws.neon.tech/akabbo?sslmode=require
```

That alone unblocks **depth A**. (If you prefer, I can also verify against a local
Docker Postgres and you keep Neon private — say the word.)

---

## 2. Google Cloud (Cloud Run) — required for B

You'll need the `gcloud` CLI (not currently installed on this machine — grab it from
<https://cloud.google.com/sdk/docs/install>, or run these in Cloud Shell).

1. **Create / pick a project**, e.g. `akabbo-staging`. Note the **Project ID**.
2. **Set billing** on the project (Cloud Run + Artifact Registry need it).
3. **Enable APIs:**
   ```bash
   gcloud services enable \
     run.googleapis.com \
     artifactregistry.googleapis.com \
     secretmanager.googleapis.com \
     cloudbuild.googleapis.com \
     iam.googleapis.com
   ```
4. **Pick a region** near the blueprint's EU choice, e.g. `europe-west1` (Belgium) or
   `europe-west3` (Frankfurt). Use the same one everywhere.
5. **Create an Artifact Registry repo** named `akabbo`:
   ```bash
   gcloud artifacts repositories create akabbo \
     --repository-format=docker --location=<REGION> \
     --description="Akabbo container images"
   ```
6. **Store secrets in Secret Manager** (the Cloud Run services reference these by
   name — see `cloudrun/*.yaml` and the deploy workflow):
   ```bash
   printf '%s' "<POOLED_DATABASE_URL>" | gcloud secrets create akabbo-database-url --data-file=-
   printf '%s' "<DIRECT_DATABASE_URL>" | gcloud secrets create akabbo-direct-url   --data-file=-
   printf '%s' "<SENTRY_DSN or empty>" | gcloud secrets create akabbo-sentry-dsn   --data-file=-
   ```
7. **Create a deploy service account** and grant it what the workflow needs:
   ```bash
   gcloud iam service-accounts create akabbo-deployer \
     --display-name="Akabbo CI deployer"

   PROJECT_ID=<PROJECT_ID>
   SA=akabbo-deployer@$PROJECT_ID.iam.gserviceaccount.com
   for ROLE in roles/run.admin roles/artifactregistry.writer \
               roles/iam.serviceAccountUser roles/secretmanager.secretAccessor; do
     gcloud projects add-iam-policy-binding $PROJECT_ID \
       --member="serviceAccount:$SA" --role="$ROLE"
   done
   ```
8. **Wire GitHub → GCP auth** with Workload Identity Federation (keyless, preferred).
   If you'd rather move fast, a service-account **JSON key** works too — tell me which
   and I'll adjust `deploy-staging.yml` accordingly.

**→ give me:**
```
GCP Project ID       = ...
GCP Region           = europe-west1   (or your choice)
Auth method          = Workload Identity Federation | SA JSON key
  (WIF) provider resource name = projects/.../locations/global/workloadIdentityPools/.../providers/...
  (WIF) deployer SA email      = akabbo-deployer@<PROJECT_ID>.iam.gserviceaccount.com
```

---

## 3. GitHub — required for B (automated deploy)

Push this repo to a GitHub repository, then set (Settings → Secrets and variables →
Actions):

**Repository *variables*** (non-secret):
| Name | Value |
|---|---|
| `GCP_PROJECT_ID` | your project id |
| `GCP_REGION` | e.g. `europe-west1` |

**Repository *secrets*:**
| Name | Value |
|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | the WIF provider resource name (if using WIF) |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `akabbo-deployer@<PROJECT_ID>.iam.gserviceaccount.com` |

**→ give me:** the repo URL (so I can confirm the workflow file is picked up) and a
note once the variables/secrets are set. If you'd rather I deploy manually from the
CLI instead of via GitHub Actions, I can run the `gcloud run deploy` commands directly
once I have §2.

---

## 4. What I do once you hand these back

**Depth A (Postgres string):**
1. Write your values into `.env`.
2. `pnpm install && pnpm prisma:generate && pnpm prisma:migrate:dev` — creates the
   Phase 0 migration and applies it to Neon.
3. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` — all green.
4. Boot both processes; `curl /health` and `/health/ready` (proves Neon reachability);
   confirm the worker logs heartbeats.
5. Report the results back to you.

**Depth B (GCP + GitHub):**
6. Build the image locally (or let CI do it), run the migration job, deploy api +
   worker to Cloud Run, and probe the public `/health` + `/health/ready` URLs.
7. Hand you the staging API URL and the heartbeat logs — that closes **CHECKPOINT 0**.

---



## Quick reference — the full set of values
```
# Neon (depth A)
DATABASE_URL=
DIRECT_URL=

# GCP (depth B)
GCP_PROJECT_ID=
GCP_REGION=
GCP_WORKLOAD_IDENTITY_PROVIDER=      # or tell me you're using a JSON key
GCP_DEPLOY_SERVICE_ACCOUNT=

# Optional
SENTRY_DSN=                          # blank = Sentry disabled (fine for Phase 0)

# GitHub (depth B)
REPO_URL=
```
