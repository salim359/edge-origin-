import json
import os
import base64

import boto3

s3 = boto3.client("s3")
cloudfront = boto3.client("cloudfront")

BUCKET = os.environ["BUCKET_NAME"]
DISTRIBUTION_ID = os.environ["DISTRIBUTION_ID"]
CONTENT_KEY = "content.json"
ALLOWED_FIELDS = ("title", "body")
MAX_BYTES = 100_000


def handler(event, context):
    method = (
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod")
        or "GET"
    ).upper()

    if method == "OPTIONS":
        return _response(204, "")

    if method != "POST":
        return _response(
            405,
            {"error": 'Use POST with JSON body { "content": { ... } }'},
        )

    try:
        raw = event.get("body") or ""
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode("utf-8")
        payload = json.loads(raw) if raw else {}
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return _response(400, {"error": "Body must be JSON"})

    content = payload.get("content")
    if not isinstance(content, dict):
        return _response(400, {"error": "content object is required"})

    cleaned = {}
    for key in ALLOWED_FIELDS:
        value = content.get(key, "")
        if not isinstance(value, str):
            return _response(400, {"error": f"{key} must be a string"})
        cleaned[key] = value

    encoded = (json.dumps(cleaned, indent=2) + "\n").encode("utf-8")
    if len(encoded) > MAX_BYTES:
        return _response(400, {"error": "content exceeds size limit"})

    s3.put_object(
        Bucket=BUCKET,
        Key=CONTENT_KEY,
        Body=encoded,
        ContentType="application/json; charset=utf-8",
        CacheControl="max-age=0, must-revalidate",
    )

    invalidation = cloudfront.create_invalidation(
        DistributionId=DISTRIBUTION_ID,
        InvalidationBatch={
            "Paths": {"Quantity": 1, "Items": [f"/{CONTENT_KEY}"]},
            "CallerReference": f"stamp-{context.aws_request_id}",
        },
    )

    inv = invalidation["Invalidation"]
    return _response(
        200,
        {
            "ok": True,
            "bucket": BUCKET,
            "key": CONTENT_KEY,
            "invalidationId": inv["Id"],
            "status": inv["Status"],
        },
    )


def _response(status, body):
    # CORS is handled by FunctionUrlConfig — do not set ACAO here
    # (duplicate headers make browsers fail the request).
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
        },
        "body": body if isinstance(body, str) else json.dumps(body),
    }
