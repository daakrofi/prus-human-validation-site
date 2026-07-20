import test from "node:test";
import assert from "node:assert/strict";
import { participantPath, shouldKeepExistingRecord, validatePayload } from "../src/index.js";

function validPayload() {
  return {
    participant: {
      name: "Test Participant",
      email: "test@example.com",
      phone: "+44 0000 000000"
    },
    session: {
      validation_unit: "topic_root_post",
      participant_email: "test@example.com",
      completed_at: null,
      responses: Array.from({ length: 500 }, (_, index) => ({
        post_id: `post-${index + 1}`,
        human_PRUS: null,
        human_domains: [],
        answered_at: null
      }))
    },
    sample_metadata: {
      sample_version: "2026-07-17-post-level-v1",
      unit_of_validation: "topic_root_post",
      target_total: 500
    }
  };
}

function componentPayload() {
  const payload = validPayload();
  payload.sample_metadata = {
    sample_version: "2026-07-18-component-first-v1",
    unit_of_validation: "topic_root_post",
    annotation_scheme: "component_first_cue_proposition_domain",
    target_total: 500
  };
  payload.session.responses = payload.session.responses.map((response) => ({
    post_id: response.post_id,
    uncertainty_cue_present: null,
    uncertain_proposition_present: null,
    human_domains: [],
    derived_PRUS: null,
    answered_at: null
  }));
  return payload;
}

function componentV2Payload() {
  const payload = componentPayload();
  payload.sample_metadata = {
    sample_version: "2026-07-18-component-first-v2",
    unit_of_validation: "topic_root_post",
    annotation_scheme: "component_first_cue_proposition_domain_none_v2",
    target_total: 500
  };
  payload.session.responses.forEach((response) => {
    response.no_qualifying_domain = null;
  });
  return payload;
}

function componentV3Payload() {
  const payload = componentV2Payload();
  payload.sample_metadata = {
    sample_version: "2026-07-20-component-first-v3",
    unit_of_validation: "topic_root_post",
    annotation_scheme: "component_first_cue_proposition_domain_none_question_test_v3",
    target_total: 500
  };
  return payload;
}

test("validates the expected sample", () => {
  const result = validatePayload(validPayload());
  assert.deepEqual(result, {
    email: "test@example.com",
    answered: 0,
    completed: false,
    sampleVersion: "2026-07-17-post-level-v1",
    responseNamespace: "post-validation-v1"
  });
});

test("accepts the alternative hybrid codebook sample in an isolated response namespace", async () => {
  const payload = validPayload();
  payload.sample_metadata.sample_version = "2026-07-18-synthetic-rubric-hybrid-v1";
  const result = validatePayload(payload);
  assert.equal(result.responseNamespace, "post-validation-synthetic-rubric-hybrid-v1");
  const path = await participantPath(result.email, result.responseNamespace);
  assert.match(path, /^responses\/post-validation-synthetic-rubric-hybrid-v1\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/);
});

test("accepts the component-first sample in its own response namespace", async () => {
  const payload = componentPayload();
  payload.session.responses[0] = {
    ...payload.session.responses[0],
    uncertainty_cue_present: true,
    uncertain_proposition_present: true,
    human_domains: ["content", "performance"],
    derived_PRUS: false
  };
  const result = validatePayload(payload);
  assert.equal(result.answered, 1);
  assert.equal(result.responseNamespace, "post-validation-component-first-v1");
  assert.equal(payload.session.responses[0].derived_PRUS, true);
  const path = await participantPath(result.email, result.responseNamespace);
  assert.match(path, /^responses\/post-validation-component-first-v1\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/);
});

test("component-first coding can stop at no uncertainty or no uncertain proposition", () => {
  const payload = componentPayload();
  payload.session.responses[0].uncertainty_cue_present = false;
  payload.session.responses[1].uncertainty_cue_present = true;
  payload.session.responses[1].uncertain_proposition_present = false;
  const result = validatePayload(payload);
  assert.equal(result.answered, 2);
  assert.equal(payload.session.responses[0].derived_PRUS, false);
  assert.equal(payload.session.responses[1].derived_PRUS, false);
});

test("component-first domains require both preceding components", () => {
  const payload = componentPayload();
  payload.session.responses[0].uncertainty_cue_present = true;
  payload.session.responses[0].uncertain_proposition_present = false;
  payload.session.responses[0].human_domains = ["content"];
  assert.throws(() => validatePayload(payload), /require both uncertainty and an uncertain proposition/);
});

test("a completed component-first session requires a domain after both positive components", () => {
  const payload = componentPayload();
  payload.session.completed_at = new Date().toISOString();
  payload.session.responses.forEach((response) => {
    response.uncertainty_cue_present = false;
  });
  payload.session.responses[0].uncertainty_cue_present = true;
  payload.session.responses[0].uncertain_proposition_present = true;
  assert.throws(() => validatePayload(payload), /must answer every post/);
});

test("component-first v2 records no qualifying domain as a completed non-PRUS decision", async () => {
  const payload = componentV2Payload();
  payload.session.responses[0].uncertainty_cue_present = true;
  payload.session.responses[0].uncertain_proposition_present = true;
  payload.session.responses[0].no_qualifying_domain = true;
  payload.session.responses[0].derived_PRUS = true;
  const result = validatePayload(payload);
  assert.equal(result.answered, 1);
  assert.equal(result.responseNamespace, "post-validation-component-first-v2");
  assert.equal(payload.session.responses[0].derived_PRUS, false);
  const path = await participantPath(result.email, result.responseNamespace);
  assert.match(path, /^responses\/post-validation-component-first-v2\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/);
});

test("component-first v2 derives PRUS when a qualifying domain is selected", () => {
  const payload = componentV2Payload();
  payload.session.responses[0].uncertainty_cue_present = true;
  payload.session.responses[0].uncertain_proposition_present = true;
  payload.session.responses[0].human_domains = ["requirements_access"];
  payload.session.responses[0].no_qualifying_domain = false;
  const result = validatePayload(payload);
  assert.equal(result.answered, 1);
  assert.equal(payload.session.responses[0].derived_PRUS, true);
});

test("component-first v2 rejects a qualifying domain combined with no qualifying domain", () => {
  const payload = componentV2Payload();
  payload.session.responses[0].uncertainty_cue_present = true;
  payload.session.responses[0].uncertain_proposition_present = true;
  payload.session.responses[0].human_domains = ["content"];
  payload.session.responses[0].no_qualifying_domain = true;
  assert.throws(() => validatePayload(payload), /cannot be combined/);
});

test("component-first v3 routes the sharpened question-test codebook separately", async () => {
  const payload = componentV3Payload();
  payload.session.responses[0].uncertainty_cue_present = true;
  payload.session.responses[0].uncertain_proposition_present = true;
  payload.session.responses[0].human_domains = ["content"];
  payload.session.responses[0].no_qualifying_domain = false;
  const result = validatePayload(payload);
  assert.equal(result.answered, 1);
  assert.equal(result.responseNamespace, "post-validation-component-first-v3");
  assert.equal(payload.session.responses[0].derived_PRUS, true);
  const path = await participantPath(result.email, result.responseNamespace);
  assert.match(path, /^responses\/post-validation-component-first-v3\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/);
});

test("canonicalizes a stale session unit when post-level sample metadata and records are valid", () => {
  const payload = validPayload();
  payload.session.validation_unit = "sentence";
  const result = validatePayload(payload);
  assert.equal(result.answered, 0);
  assert.equal(payload.session.validation_unit, "topic_root_post");
});

test("rejects completed PRUS responses without a domain", () => {
  const payload = validPayload();
  payload.session.completed_at = new Date().toISOString();
  payload.session.responses = payload.session.responses.map((response) => ({
    ...response,
    human_PRUS: true,
    human_domains: []
  }));
  assert.throws(() => validatePayload(payload), /product topic domain/);
});

test("accepts multiple valid product topic domains for a PRUS post", () => {
  const payload = validPayload();
  payload.session.responses[0].human_PRUS = true;
  payload.session.responses[0].human_domains = ["content", "performance"];
  const result = validatePayload(payload);
  assert.equal(result.answered, 1);
});

test("rejects domains attached to a Not PRUS post", () => {
  const payload = validPayload();
  payload.session.responses[0].human_PRUS = false;
  payload.session.responses[0].human_domains = ["content"];
  assert.throws(() => validatePayload(payload), /cannot have product topic domains/);
});

test("rejects submissions from the superseded validation sample", () => {
  const payload = validPayload();
  payload.sample_metadata.sample_version = "2026-07-08-superseded";
  assert.throws(() => validatePayload(payload), /Unexpected validation sample metadata/);
});

test("participant paths are stable and do not expose email addresses", async () => {
  const first = await participantPath("Test@Example.com");
  const second = await participantPath("test@example.com");
  assert.equal(first, second);
  assert.match(first, /^responses\/post-validation-v1\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/);
  assert.equal(first.includes("example.com"), false);
});

test("keeps a more advanced checkpoint when an older request arrives later", () => {
  const existing = { received_at: "2026-07-17T12:00:00Z", session: validPayload().session };
  existing.session.responses.slice(0, 100).forEach((response) => {
    response.human_PRUS = false;
  });
  existing.session.updated_at = "2026-07-17T12:00:00Z";

  const incoming = { received_at: "2026-07-17T11:59:00Z", session: validPayload().session };
  incoming.session.responses.slice(0, 75).forEach((response) => {
    response.human_PRUS = false;
  });
  incoming.session.updated_at = "2026-07-17T11:59:00Z";

  assert.equal(shouldKeepExistingRecord(existing, incoming), true);
});

test("allows a newer correction with the same number of answered sentences", () => {
  const existing = { received_at: "2026-07-17T12:00:00Z", session: validPayload().session };
  const incoming = { received_at: "2026-07-17T12:01:00Z", session: validPayload().session };
  existing.session.updated_at = "2026-07-17T12:00:00Z";
  incoming.session.updated_at = "2026-07-17T12:01:00Z";
  assert.equal(shouldKeepExistingRecord(existing, incoming), false);
});

test("allows completion to replace a 500-answer checkpoint with the same timestamp", () => {
  const existing = { received_at: "2026-07-17T12:00:00Z", session: validPayload().session };
  const incoming = { received_at: "2026-07-17T12:00:00Z", session: validPayload().session };
  for (const record of [existing, incoming]) {
    record.session.updated_at = "2026-07-17T12:00:00Z";
    record.session.responses.forEach((response) => {
      response.human_PRUS = false;
      response.human_domains = [];
    });
  }
  incoming.session.completed_at = "2026-07-17T12:00:00Z";
  assert.equal(shouldKeepExistingRecord(existing, incoming), false);
});
