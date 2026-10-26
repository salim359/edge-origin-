# Day 08 — Private S3 + CloudFront OAC

Static website stored in a private S3 bucket and delivered through CloudFront with Origin Access Control (OAC). A small Lambda Function URL lets the browser stamp `content.json` updates and invalidate the edge cache.

## Demo

<video src="test/public/demo.webm" controls width="720"></video>

[Download demo.webm](test/public/demo.webm)

---

## 1. Problem

Public S3 website hosting exposes the bucket (or requires awkward workarounds). This project keeps the bucket **fully private** while still serving a fast HTTPS site:

- Visitors reach content only through CloudFront.
- CloudFront proves its identity to S3 with OAC (SigV4).
- Editors can update lab notes from the page itself (Stamp → upload `content.json` → invalidate cache) without opening the bucket to the internet.

## 2. Architecture

| Service | Role | Why |
|--------|------|-----|
| **Amazon S3** | Private origin for HTML/CSS/JS/`content.json` | Cheap object storage; public access blocked; versioning for recovery |
| **CloudFront OAC** | Signs origin requests with SigV4 | Replaces legacy OAI; scoped trust between one distribution and the bucket |
| **Amazon CloudFront** | Public HTTPS CDN, default root `index.html` | Edge cache, TLS, redirects HTTP→HTTPS |
| **S3 bucket policy** | Allows `s3:GetObject` only from this distribution ARN | Least-privilege read path |
| **AWS Lambda + Function URL** | Stamp API: `PutObject` on `content.json` + `CreateInvalidation` | Browser cannot hold long-lived AWS keys; CORS limited to the CloudFront origin |
| **AWS SAM / CloudFormation** | Provisions the stack as code | Repeatable deploy and teardown |

```
Browser ──HTTPS──► CloudFront ──OAC/SigV4──► private S3
   │
   └──POST (Stamp)──► Lambda Function URL ──► S3 PutObject + CloudFront invalidation
```

## 3. Event / request flow

### Read path (page load)

1. Browser requests `https://<distribution>/` (or `/content.json`, CSS, JS).
2. CloudFront returns a cached object if present (`x-cache: Hit from cloudfront`).
3. On miss, CloudFront fetches from the S3 regional endpoint; OAC signs the request.
4. Bucket policy allows the get only when `AWS:SourceArn` matches this distribution.
5. Default root object `index.html` is used for `/`.

### Write path (Stamp button)

1. User edits title/body in the page and clicks **Stamp**.
2. Browser `POST`s JSON `{ "content": { "title", "body" } }` to the Lambda Function URL (CORS origin = CloudFront domain).
3. Lambda validates payload (allowed fields, size ≤ 100 KB), writes `content.json` to S3 with `CacheControl: max-age=0, must-revalidate`.
4. Lambda creates a CloudFront invalidation for `/content.json` using `CallerReference` = `stamp-<request-id>`.
5. After invalidation completes, a refresh loads the new notes through CloudFront.

## 4. Deployment

Prerequisites: AWS CLI, SAM CLI, credentials for the target account/region (`us-east-1` in `samconfig.toml`).

```bash
cd day08-static-website

# Validate
sam validate --lint

# Build Lambda (Makefile packaging under admin/)
sam build

# Deploy (guided first time, or reuse samconfig.toml)
sam deploy

# Upload static assets
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name static-website \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" \
  --output text)

# Put PublishUrl into site/config.js, then:
aws s3 sync site/ "s3://${BUCKET}/" --delete
```

Stack outputs: `WebsiteURL`, `BucketName`, `DistributionId`, `PublishUrl`, `OriginAccessControlId`.

## 5. Testing

Details and screenshots: [test/test.md](test/test.md). Summary of results:

| Scenario | What we did | Result |
|----------|-------------|--------|
| **Website update + invalidation** | Synced updated `site/` to S3, ran `create-invalidation` for `/` and `/index.html` | Invalidation created (`InProgress` → `Completed`); browser showed the new content |
| **Caching headers** | `curl -sSI "$SITE_URL/"` | `HTTP/2 200`, `x-cache: Hit from cloudfront`, `via` / `age` / `x-amz-cf-pop` present; `server: AmazonS3` as origin |
| **Private origin** | Direct HTTPS GET to the bucket object URL | `403 Access Denied` — bucket stays non-public |
| **Stamp demo** | Edit notes in the UI and publish | See [demo.webm](test/public/demo.webm) |

![Website update and cache invalidation](test/public/website_update_and_cache_invalidation.png)

![Inspect caching headers](test/public/inspect_cache_headers.png)

## 6. Security

- **S3 public access block** — all four Block Public Access settings enabled; no website endpoint / public ACLs.
- **OAC + bucket policy** — only the named CloudFront distribution can `GetObject`; unsigned/public S3 URLs fail.
- **Viewer TLS** — `ViewerProtocolPolicy: redirect-to-https`.
- **Lambda IAM** — least privilege: `s3:PutObject` on `…/content.json` only, and `cloudfront:CreateInvalidation` on this distribution only.
- **Function URL** — `AuthType: NONE` (lab trade-off) but CORS `AllowOrigins` locked to the CloudFront domain; body validated and size-capped.
- **No secrets in the static site** — browser holds only the Function URL, not AWS access keys.
- **Encryption at rest** — S3 default encryption (SSE-S3 observed on responses as `AES256`).

> Harden before production: add auth on the Function URL (IAM / Cognito / shared secret), WAF on CloudFront, and tighter publish authorization.

## 7. Reliability

- **CloudFront** retries origin fetches on transient edge/origin failures; clients should retry idempotent GETs.
- **Stamp Lambda** — input validation returns `400`/`405` instead of partial writes; unexpected AWS API errors surface as Function URL 5xx for the client to retry.
- **Invalidation idempotency** — `CallerReference` uses the Lambda request ID so a single invocation does not create ambiguous duplicate batches; a user clicking Stamp twice intentionally creates two updates (last write wins on `content.json`).
- **S3 versioning** — previous object versions remain recoverable after overwrite.
- **Client UX** — Stamp disables the button while in flight and reports success/failure in the page status line; `content.json` is fetched with `cache: "no-store"` so editors see fresher notes after publish.

There is no SQS/SNS in this design; duplicates are browser/user-driven POSTs, not queue redeliveries.

## 8. Costs and cleanup

**What can incur charges**

- CloudFront data transfer and HTTPS requests (PriceClass_100 limits edge footprint).
- S3 storage, `PUT`/`GET`, and versioned object retention.
- CloudFront invalidations (first 1,000 paths/month often free; beyond that billed per path).
- Lambda invocations + Function URL request volume (Stamp traffic is usually tiny).
- SAM-managed packaging bucket artifacts if left behind.

**Remove resources**

```bash
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name static-website \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" \
  --output text)

# Empty current objects (and delete versions if needed before stack delete)
aws s3 rm "s3://${BUCKET}/" --recursive

sam delete --stack-name static-website
```

If CloudFormation cannot delete a non-empty versioned bucket, delete remaining versions/delete-markers in the console or via `s3api`, then retry `sam delete`.

---

## Layout

```
static-website/
├── template.yaml   # SAM stack (S3, OAC, CloudFront, publish Lambda)
├── site/           # Static assets + config.js (PublishUrl)
├── admin/          # Publish Lambda (app.py)
└── test/           # Test notes, screenshots, demo.webm
```
