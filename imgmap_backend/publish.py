"""Uploads results as soon as they exist, so a run that stops part-way
(cancelled, timed out) loses nothing, and the bucket fills as it goes."""

from __future__ import annotations

import logging
import os
import threading

log = logging.getLogger("publish")

# Content-addressed PDFs never change; JSON is refreshed by later runs.
_PDF_HEADERS = {"ContentType": "application/pdf", "CacheControl": "public, max-age=31536000, immutable"}
_JSON_HEADERS = {"ContentType": "application/json", "CacheControl": "public, max-age=300"}
# The pipeline's own progress: never served stale to the next run.
_STATE_HEADERS = {"ContentType": "application/json", "CacheControl": "no-store"}


class Publisher:
    """Keeps results in the output directory only (e.g. a VPS serving it)."""

    def put(self, key: str, data: bytes):
        pass

    def get(self, key: str) -> bytes | None:
        """A published file, read from the store itself (not a cache)."""
        return None


class R2Publisher(Publisher):
    """Uploads each file to a Cloudflare R2 (S3-compatible) bucket."""

    def __init__(self, account_id: str, access_key: str, secret_key: str, bucket: str):
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name="auto",
            config=Config(retries={"max_attempts": 5, "mode": "standard"}),
        )
        self._lock = threading.Lock()
        self.uploaded = 0

    @classmethod
    def from_env(cls) -> R2Publisher:
        try:
            return cls(
                os.environ["R2_ACCOUNT_ID"],
                os.environ["R2_ACCESS_KEY_ID"],
                os.environ["R2_SECRET_ACCESS_KEY"],
                os.environ["R2_BUCKET"],
            )
        except KeyError as e:
            raise SystemExit(f"--publish-r2 needs the environment variable {e}") from None

    def put(self, key: str, data: bytes):
        if key.endswith(".pdf"):
            headers = _PDF_HEADERS
        elif key.endswith("state.json"):
            headers = _STATE_HEADERS
        else:
            headers = _JSON_HEADERS
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, **headers)
        with self._lock:
            self.uploaded += 1

    def get(self, key: str) -> bytes | None:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.client.exceptions.NoSuchKey:
            return None
