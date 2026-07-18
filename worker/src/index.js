const MAX_BODY_BYTES = 2_000_000;
const EXPECTED_SAMPLE_SIZE = 500;
const DEFAULT_RESPONSE_NAMESPACE = "post-validation-v1";
const SAMPLE_PROFILES = new Map([
  [
    "2026-07-17-post-level-v1",
    {
      validationUnit: "topic_root_post",
      responseNamespace: DEFAULT_RESPONSE_NAMESPACE
    }
  ],
  [
    "2026-07-18-synthetic-rubric-hybrid-v1",
    {
      validationUnit: "topic_root_post",
      responseNamespace: "post-validation-synthetic-rubric-hybrid-v1"
    }
  ]
]);
const ALLOWED_DOMAINS = new Set(["content", "performance", "requirements_access"]);
const MAX_GITHUB_SAVE_ATTEMPTS = 8;
const RETRYABLE_GITHUB_STATUSES = new Set([409, 422, 429, 500, 502, 503, 504]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function allowedOrigins(env) {
  return new Set(
    String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json;charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  };
  if (allowedOrigins(env).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

function jsonResponse(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders(request, env)
  });
}

function requiredString(value, field, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return normalized;
}

export function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "Invalid JSON payload");
  }

  const participant = payload.participant;
  const session = payload.session;
  const metadata = payload.sample_metadata;
  if (!participant || !session || !metadata) {
    throw new HttpError(400, "Participant, session, and sample metadata are required");
  }

  const email = requiredString(participant.email, "participant email", 254).toLowerCase();
  if (!email.includes("@")) {
    throw new HttpError(400, "Invalid participant email");
  }
  requiredString(participant.name, "participant name", 200);
  requiredString(participant.phone, "participant phone", 80);

  if (String(session.participant_email || "").trim().toLowerCase() !== email) {
    throw new HttpError(400, "Participant and session email do not match");
  }
  if (!Array.isArray(session.responses) || session.responses.length !== EXPECTED_SAMPLE_SIZE) {
    throw new HttpError(400, `Session must contain ${EXPECTED_SAMPLE_SIZE} responses`);
  }
  const sampleVersion = String(metadata.sample_version || "");
  const sampleProfile = SAMPLE_PROFILES.get(sampleVersion);
  if (
    !sampleProfile ||
    String(metadata.unit_of_validation || "") !== sampleProfile.validationUnit
  ) {
    throw new HttpError(400, "Unexpected validation sample metadata");
  }

  // The versioned sample metadata and the post-response schema below are the
  // authoritative unit checks. The session copy is redundant and may be stale
  // after a deployment or altered by browser instrumentation. Canonicalize it
  // after validating the authoritative fields instead of rejecting valid work.
  session.validation_unit = sampleProfile.validationUnit;

  let answered = 0;
  const postIds = new Set();
  for (const response of session.responses) {
    if (!response || typeof response !== "object") {
      throw new HttpError(400, "Invalid response record");
    }
    if (![null, true, false].includes(response.human_PRUS)) {
      throw new HttpError(400, "Invalid human PRUS value");
    }
    const postId = requiredString(response.post_id, "post id", 300);
    if (postIds.has(postId)) {
      throw new HttpError(400, "Post IDs must be unique");
    }
    postIds.add(postId);
    if (!Array.isArray(response.human_domains)) {
      throw new HttpError(400, "Human product topic domains must be an array");
    }
    const domains = [...new Set(response.human_domains)];
    if (domains.length !== response.human_domains.length || domains.some((domain) => !ALLOWED_DOMAINS.has(domain))) {
      throw new HttpError(400, "Invalid human product topic domains");
    }
    if (response.human_PRUS === false && domains.length > 0) {
      throw new HttpError(400, "A Not PRUS response cannot have product topic domains");
    }
    if (response.human_PRUS === false || (response.human_PRUS === true && domains.length > 0)) {
      answered += 1;
    }
  }

  if (session.completed_at) {
    if (session.responses.some((response) => response.human_PRUS === true && response.human_domains.length === 0)) {
      throw new HttpError(400, "Every completed PRUS response requires at least one product topic domain");
    }
    if (answered !== EXPECTED_SAMPLE_SIZE) {
      throw new HttpError(400, "A completed session must answer every post");
    }
  }

  return {
    email,
    answered,
    completed: Boolean(session.completed_at),
    sampleVersion,
    responseNamespace: sampleProfile.responseNamespace
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function participantPath(email, responseNamespace = DEFAULT_RESPONSE_NAMESPACE) {
  const hash = await sha256(email.trim().toLowerCase());
  return `responses/${responseNamespace}/${hash.slice(0, 2)}/${hash}.json`;
}

function base64EncodeUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64DecodeUtf8(value) {
  const binary = atob(String(value || "").replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function savedProgress(record) {
  const responses = Array.isArray(record?.session?.responses) ? record.session.responses : [];
  const answered = responses.filter(
    (response) => response?.human_PRUS === false
      || (response?.human_PRUS === true && Array.isArray(response?.human_domains) && response.human_domains.length > 0)
  ).length;
  const updatedAt = Date.parse(record?.session?.updated_at || record?.received_at || "") || 0;
  return {
    answered,
    completed: Boolean(record?.session?.completed_at),
    updatedAt
  };
}

export function shouldKeepExistingRecord(existingRecord, incomingRecord) {
  if (!existingRecord?.session || !incomingRecord?.session) return false;
  const existing = savedProgress(existingRecord);
  const incoming = savedProgress(incomingRecord);
  if (existing.completed !== incoming.completed) return existing.completed;
  if (existing.answered > incoming.answered) return true;
  if (existing.answered < incoming.answered) return false;
  return existing.updatedAt >= incoming.updatedAt;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function githubHeaders(env) {
  if (!env.GITHUB_TOKEN) {
    throw new HttpError(500, "GitHub writer is not configured");
  }
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "prus-validation-github-writer"
  };
}

function githubContentsUrl(env, path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${encodedPath}`;
}

async function existingFile(env, path) {
  const response = await fetch(`${githubContentsUrl(env, path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`, {
    headers: githubHeaders(env)
  });
  if (response.status === 404) return { sha: null, record: null };
  if (!response.ok) {
    const detail = await response.text();
    throw new HttpError(502, `GitHub lookup failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const body = await response.json();
  let record = null;
  try {
    record = body.content ? JSON.parse(base64DecodeUtf8(body.content)) : null;
  } catch {
    record = null;
  }
  return { sha: body.sha || null, record };
}

async function commitRecord(env, path, record, summary) {
  let lastStatus = 0;
  let lastDetail = "";

  for (let attempt = 0; attempt < MAX_GITHUB_SAVE_ATTEMPTS; attempt += 1) {
    const current = await existingFile(env, path);
    if (shouldKeepExistingRecord(current.record, record)) {
      return { commit: null, existing_sha: current.sha, unchanged: true };
    }

    const body = {
      message: `PRUS validation ${summary.completed ? "completed" : "checkpoint"}: ${path.split("/").pop().slice(0, 12)} (${summary.answered}/${EXPECTED_SAMPLE_SIZE})`,
      content: base64EncodeUtf8(`${JSON.stringify(record, null, 2)}\n`),
      branch: env.GITHUB_BRANCH || "main"
    };
    if (current.sha) body.sha = current.sha;

    const response = await fetch(githubContentsUrl(env, path), {
      method: "PUT",
      headers: { ...githubHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (response.ok) return response.json();

    lastStatus = response.status;
    lastDetail = (await response.text()).slice(0, 300);
    if (!RETRYABLE_GITHUB_STATUSES.has(response.status)) {
      throw new HttpError(502, `GitHub save failed (${response.status}): ${lastDetail}`);
    }
    if (attempt < MAX_GITHUB_SAVE_ATTEMPTS - 1) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1600, 100 * (2 ** attempt)) + Math.floor(Math.random() * 100);
      await sleep(backoff);
    }
  }

  throw new HttpError(503, `GitHub save remained busy after retries (${lastStatus}): ${lastDetail}`);
}

async function handlePost(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!allowedOrigins(env).has(origin)) {
    throw new HttpError(403, "Origin is not permitted");
  }
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Payload is too large");
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  const summary = validatePayload(payload);
  const path = await participantPath(summary.email, summary.responseNamespace);
  const record = {
    schema_version: 2,
    received_at: new Date().toISOString(),
    save_reason: String(payload.save_reason || "unspecified").slice(0, 40),
    participant: payload.participant,
    session: payload.session,
    sample_metadata: payload.sample_metadata
  };
  const githubResult = await commitRecord(env, path, record, summary);
  return jsonResponse(request, env, {
    ok: true,
    saved: true,
    completed: summary.completed,
    answered: summary.answered,
    path,
    commit_sha: githubResult.commit?.sha || githubResult.existing_sha || null,
    unchanged: Boolean(githubResult.unchanged)
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(request, env, { ok: true, configured: Boolean(env.GITHUB_TOKEN) });
      }
      if (request.method === "POST" && url.pathname === "/collect") {
        return await handlePost(request, env);
      }
      return jsonResponse(request, env, { ok: false, error: "Not found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Internal server error";
      console.error(JSON.stringify({ event: "request_failed", status, message }));
      return jsonResponse(request, env, { ok: false, error: message }, status);
    }
  }
};
