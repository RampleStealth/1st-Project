# Priority Policy v1 and Attention Contract v1

## Document control

| Field | Value |
| --- | --- |
| Status | Approved |
| Version | 1.0 |
| Owner | Wong Studio |
| Effective sprint | Sprint 1 |
| Founder decision | FD-001 |

This document is the constitutional engineering source of truth for Priority Policy v1 and Attention Contract v1. Implementations must not infer, extend, or silently reinterpret unresolved policy. A section marked `TODO (Founder Approval Required)` is non-operative until the Founder approves a concrete replacement in this document.

## Constitutional Scope

This document defines the deterministic attention policy used by Wong Email.

It intentionally excludes semantic interpretation, AI reasoning, provider-specific implementations, engineering optimizations, and implementation details unless explicitly stated.

Its purpose is to establish constitutional guarantees that remain stable across implementations and providers.

## Table of contents

1. [Purpose](#1-purpose)
2. [Philosophy](#2-philosophy)
3. [Design promise](#3-design-promise)
4. [Candidate scope](#4-candidate-scope)
5. [Priority tiers](#5-priority-tiers)
6. [Deterministic rule set](#6-deterministic-rule-set)
   1. [Signal classification](#61-signal-classification)
   2. [Recency](#62-recency)
   3. [Provider Mapping](#63-provider-mapping)
   4. [AI Independence](#64-ai-independence)
7. [Reason codes](#7-reason-codes)
8. [Ordering rules](#8-ordering-rules)
9. [Future timestamp handling](#9-future-timestamp-handling)
10. [User overrides](#10-user-overrides)
11. [Freshness policy](#11-freshness-policy)
12. [Attention Contract v1](#12-attention-contract-v1)
13. [UX contract](#13-ux-contract)
14. [Non-goals](#14-non-goals)
15. [Success metrics](#15-success-metrics)
16. [Known risks](#16-known-risks)
17. [Future evolution](#17-future-evolution)
18. [Founder approval record](#18-founder-approval-record)
19. [Revision history](#19-revision-history)

## 1. Purpose

Priority Policy v1 helps a user identify which eligible inbox threads have trustworthy evidence that they may deserve attention. It reduces the burden of deciding where to begin when opening a busy inbox.

The policy produces an explainable recommendation from deterministic mailbox metadata. It does not claim to know a user's intent, relationships, deadlines, emotional context, or the true importance of a message.

The policy does not replace Gmail, modify Gmail's classifications, or decide on the user's behalf.

## 2. Philosophy

All policy and implementation decisions must uphold these principles:

- Truth before intelligence
- Explainability before automation
- Trust before delight
- Calm before productivity
- Evidence before assumptions

Priority Policy v1 is deterministic and non-AI. It may use only evidence explicitly authorized by this document. Missing evidence must remain missing; it must not be inferred.

## 3. Design promise

The Priority Policy exists to reduce uncertainty.

It does not replace the user's judgment.

It does not compete with Gmail.

It simply helps people begin.

Every recommendation should make the first step feel lighter—not make the decision for them.

## 4. Candidate scope

The candidate set must be policy-scoped, owner-scoped, and described truthfully to the user. The system must never imply that it evaluated an entire mailbox when it evaluated only the eligible candidate scope.

The policy evaluates thread-level normalized metadata. Message bodies, snippets, attachment contents, and generated summaries are not candidate evidence.

The exact scope remains unresolved:

- **PPV1-001 — Eligible Gmail location:** TODO (Founder Approval Required): Define whether candidates are limited to threads currently carrying the Gmail `INBOX` label and whether Spam, Trash, archived mail, Sent, and Drafts are categorically excluded.
- **PPV1-002 — Maximum candidate count:** The policy defines no maximum candidate count. Implementations may batch, paginate, stream, parallelize, or otherwise optimize evaluation provided every eligible candidate remains eligible for deterministic evaluation.
  - **PPV1-002A — Time-to-first-result guarantee:** TODO (Founder Approval Required): Define the maximum permitted time before the first eligible deterministic result is available.
  - **PPV1-002B — Candidate lookback duration:** TODO (Founder Approval Required): Define whether candidate eligibility has a maximum lookback duration and, if so, its exact boundary semantics.
- **PPV1-003 — Candidate timestamp:** TODO (Founder Approval Required): Define which normalized timestamp determines whether a thread is inside the candidate window.
- **PPV1-004 — Missing metadata fallback:** Missing metadata must never be inferred. Each missing field follows the approved deterministic behavior below.

  | Missing Metadata | Deterministic Behavior | Founder Status |
  | --- | --- | --- |
  | Received timestamp (`PPV1-004A`) | TODO (Founder Approval Required) | Pending |
  | Sender (`PPV1-004B`) | TODO (Founder Approval Required) | Pending |
  | Labels (`PPV1-004C`) | TODO (Founder Approval Required) | Pending |
  | User overrides (`PPV1-004D`) | TODO (Founder Approval Required) | Pending |

- **PPV1-005 — Synchronization requirement:** TODO (Founder Approval Required): Define the minimum mailbox synchronization state required before an evaluation may be presented as current.
- **PPV1-006 — Empty candidate behavior:** TODO (Founder Approval Required): Define the contract and user-facing meaning when no eligible candidates exist.

Candidate selection must be deterministic. Given the same normalized projection, evaluation instant, and approved scope, candidate membership must be identical.

## 5. Priority tiers

The constitutional tier identifiers are:

- `NEEDS_ATTENTION`
- `REVIEW_LATER`
- `NO_IMMEDIATE_SIGNALS`

- **PPV1-007 — Tier identifiers:** The identifiers above are the complete Priority Policy v1 tier registry. No implementation may introduce an additional tier under policy version `1.0`.
- **PPV1-008 — Tier semantics:** Priority Policy v1 uses rule-assigned evidence semantics:
  - `NEEDS_ATTENTION`: At least one approved constitutional rule explicitly assigns the candidate to the highest attention tier.
  - `REVIEW_LATER`: At least one approved constitutional rule assigns the candidate for later review, and no applicable rule assigns `NEEDS_ATTENTION`.
  - `NO_IMMEDIATE_SIGNALS`: No approved constitutional rule assigns either higher tier, subject to active user-correction rules.

  These tiers express evidence-based attention guidance. They do not claim urgency, objective importance, certainty, or required action.

  PPV1-008 does not decide which signals map to which tiers. Signal mappings, combinations, correction mappings, and UI labels remain governed by their separate Founder decisions.
- **PPV1-009 — Default tier:** When an eligible candidate has no affirmative constitutional signal and no active user correction, Priority Policy v1 shall assign:
  - `tier`: `NO_IMMEDIATE_SIGNALS`
  - `reasonCodes`: `[]`
  - `reasons`: `[]`

  `NO_IMMEDIATE_SIGNALS` does not mean unimportant, irrelevant, or safe to ignore. It means no approved constitutional rule currently assigns `REVIEW_LATER` or `NEEDS_ATTENTION`.

  Eligible candidates shall not be omitted merely because they have no affirmative signal. Missing or unavailable metadata remains governed separately by PPV1-004 and must not be treated as equivalent to confirmed absence of evidence.

Tier assignment must be deterministic. The engine must not emit confidence, inferred urgency, or an unapproved intermediate tier. PPV1-020 remains authoritative for the unresolved priority ordering of the approved identifiers.

## 6. Deterministic rule set

The evaluator may consume only normalized metadata already available from the mailbox projection and explicitly approved in this section.

Available normalized evidence includes:

- Gmail system-label presence, including `UNREAD`, `STARRED`, `IMPORTANT`, and `INBOX`
- normalized thread activity timestamp
- normalized sender and recipient addresses
- thread-level attachment presence
- owner-scoped user override metadata when that contract is implemented

Availability does not authorize a field as a ranking signal. The exact operative rules remain unresolved:

- **PPV1-010 — Remaining signal decisions:** TODO (Founder Approval Required): Identify which available metadata fields other than Manual user star and Recency are operative Priority Policy v1 signals.
- **PPV1-010A — Provider-Verifiable Signal Origin:** Every approved signal must have a provider-verifiable origin. Signals whose origin cannot be distinguished from provider inference or AI classification are not constitutional inputs to Priority Policy.
- **PPV1-011 — Rule-to-tier mapping:** Individual constitutional signals map as follows:
  - **Provider-verifiable Manual Star**
    - `tier`: `REVIEW_LATER`
    - `reasonCode`: `MANUAL_STAR`

    A Manual Star is explicit, user-verifiable intent that the candidate should remain visible for review. A Manual Star does not necessarily mean urgency, immediate action, or a request to begin with that candidate. Therefore, Manual Star elevates the candidate above `NO_IMMEDIATE_SIGNALS` but does not independently assign `NEEDS_ATTENTION`.
  - **Recency alone**
    - `tier`: `NO_IMMEDIATE_SIGNALS`
    - `reasonCodes`: `[]`
    - `reasons`: `[]`

    Recency tells time, not importance. Recency alone does not promote a tier and does not constitute a reason for the assigned tier. Recency may be used only as a deterministic ordering rule among otherwise constitutionally equal candidates.

  Do not emit `RECENCY` merely because a valid timestamp exists. The `RECENCY` reason code remains registered but inactive unless a future Founder-approved rule gives it an explanatory constitutional condition.

  `NEEDS_ATTENTION` remains available for explicit correction mappings or other future Founder-approved rules. This decision does not resolve corrections, missing metadata, or provider-specific mappings.
- **PPV1-012 — Combined-signal behavior:** Highest assigned tier wins, with no combinational promotion.
  1. **Individual rule evaluation:** Each applicable approved constitutional rule evaluates independently and may produce only its Founder-approved tier assignment and authorized reason.
  2. **Correction handling:** Active user corrections are resolved under PPV1-025 through PPV1-027 before ordinary rule conflict resolution.
  3. **Final tier assignment:** After correction handling, the final tier is the constitutionally highest tier actually assigned by an applicable approved rule.
  4. **No accumulation:** Multiple signals shall not accumulate, add weight, or combine into a higher tier merely because they coexist. A combination may produce a distinct or higher tier only when a separate Founder-approved constitutional combination rule explicitly assigns that outcome.
  5. **Reasons:** Reasons remain governed by PPV1-018 and PPV1-019. PPV1-019 determines the visibility of lower-tier supporting reasons in a higher-tier result.

  Current approved example:

  - Manual Star plus Recency:
    - `tier`: `REVIEW_LATER`
    - `reasonCodes`: [`MANUAL_STAR`]

  `RECENCY` remains inactive and is not emitted. Recency may still order otherwise constitutionally equal candidates.

  The policy shall not use scores, weights, confidence values, probabilistic ranking, or inferred promotion.
- **PPV1-014 — Attachment treatment:** TODO (Founder Approval Required): State explicitly whether attachment presence affects Priority Policy v1 or is projection metadata only.
- **PPV1-015 — Sender and recipient treatment:** TODO (Founder Approval Required): State explicitly whether normalized addresses affect Priority Policy v1 or are projection metadata only.

The engine must not:

- inspect message bodies, snippets, or attachment contents;
- inspect AI summaries;
- add unapproved weights or scores;
- infer urgency, intent, relationship strength, deadlines, or sentiment;
- use randomness, hidden heuristics, or wall-clock access;
- silently treat missing metadata as affirmative evidence.

The caller must supply a fixed `evaluatedAt` instant. Identical policy inputs, including `evaluatedAt`, must produce structurally identical outputs.

### 6.1 Signal classification

#### Approved signals

| Signal | Founder Status | Constitutional Basis |
| --- | --- | --- |
| Manual user star | Approved | A manually applied star is an explicit user action and therefore satisfies the constitutional requirements of objective, deterministic, and user-verifiable evidence. |
| Recency | Approved | Recency provides objective temporal context. It does not represent importance and cannot promote a tier by itself. |

The individual tier mappings are governed by PPV1-011. Combined-signal behavior, canonical human-readable wording, and Recency parameter values remain governed by PPV1-012, PPV1-017A, and the unresolved Recency parameters below.

#### Not approved signals

| Signal | Founder Status | Constitutional Boundary |
| --- | --- | --- |
| Manual/provider importance | Not Approved | A provider importance signal is approved only if its origin can be verified as an explicit user action. If the implementation cannot distinguish user-applied importance from provider-generated importance, the signal shall not participate in Priority Policy. |

### 6.2 Recency

- **PPV1-013 — Constitutional role of Recency:** Recency is an approved deterministic signal. Its purpose is to provide objective temporal context. Recency does not represent importance.
- **PPV1-013A — Recency Represents Time:** Recency tells time, not importance. Priority Policy shall treat recency solely as objective temporal evidence. Importance shall never be inferred from recency alone.
- **PPV1-013B — No Tier Promotion:** Recency alone shall never increase an email's Priority Policy tier. It may participate only according to the deterministic constitutional rules.
- **PPV1-013C — Explicit User Intent Dominance:** Explicit user actions always take precedence over passive metadata.

  Examples of explicit actions include:

  - Manual Star
  - User Override
  - Future Founder-approved manual controls

  Examples of passive metadata include:

  - Timestamp
  - Arrival order
  - Provider-generated metadata

  Passive metadata shall not override explicit user intent.

- **PPV1-013D — Deterministic Ordering:** When two candidates are otherwise constitutionally equal, recency may be used solely as a deterministic ordering rule. It shall not create, modify, or elevate Priority Policy tiers.

#### Time and Importance

Priority Policy separates objective temporal facts from constitutional attention decisions.

Time describes when an event occurred.

Importance is not inferred from time.

Recency may provide temporal context and deterministic ordering only within the constitutional boundaries above.

**Recency parameter values:** TODO (Founder Approval Required): Define the Recency window, number of hours, lookback duration, and exact boundary semantics.

Freshness thresholds and cache duration remain unresolved under PPV1-030 and PPV1-033. The Constitution defines the role of Recency before defining its parameter values.

### 6.3 Provider Mapping

Priority Policy operates exclusively on provider-neutral normalized signals.

Provider-specific concepts such as Star, Flag, Category, and equivalent concepts must be translated by provider adapters. The constitutional policy itself shall not depend on provider-specific terminology.

The provider-neutral mapping contract will be defined in [`docs/product/provider-mapping-spec-v1.md`](provider-mapping-spec-v1.md).

**TODO (Future Specification):** Create and approve `docs/product/provider-mapping-spec-v1.md`.

### 6.4 AI Independence

No AI component may directly assign, modify, or reorder Priority Policy tiers.

AI systems may produce recommendations, explanations, summaries, or future assistant suggestions.

Priority Policy remains solely determined by constitutional deterministic rules.

## 7. Reason codes

Every affirmative policy conclusion must be explainable through stable, localization-friendly reason codes and approved human-readable wording.

### PPV1-016 — Evidence-specific reason-code registry

The constitutional reason-code registry is:

| Reason code | Constitutional evidence | Emission dependency |
| --- | --- | --- |
| `USER_PRIORITIZE` | Active Prioritize correction | PPV1-025 |
| `USER_NOT_IMPORTANT` | Active Not Important correction | PPV1-026 |
| `MANUAL_STAR` | Provider-verifiable Manual Star | PPV1-011 |
| `RECENCY` | Objective temporal context | Inactive unless a future Founder-approved rule defines an explanatory constitutional condition |

Reason codes identify approved constitutional evidence. They shall never infer importance, urgency, confidence, or AI judgment.

Registration does not authorize emission before the referenced constitutional condition is approved.

### PPV1-017 — Human-readable reason representation

Each reason shall define:

- a stable localization key;
- canonical Founder-approved English wording.

The Constitution owns semantic meaning. Presentation layers may localize the wording but shall not reinterpret constitutional meaning.

- **PPV1-017A — Localization keys and canonical English wording:** TODO (Founder Approval Required): Approve the exact stable localization key and canonical English wording for each reason code in PPV1-016.

### PPV1-018 — Reason precedence

When simultaneous reasons are emitted, they shall be returned in this constitutional precedence:

1. Active User Correction
2. Manual Star
3. Recency

The applicable Active User Correction reason or reasons remain governed by the unresolved correction semantics in PPV1-025 through PPV1-029.

This ordering preserves the constitutional rule that explicit user intent outranks passive metadata.

### PPV1-019 — Negative reasons

Priority Policy v1 shall retain all applicable authorized affirmative evidence reasons and all active explicit user-correction reasons, including lower-tier supporting reasons, even when another rule determines the final tier.

1. **Affirmative evidence:** An authorized reason may be emitted only when its Founder-approved constitutional condition is satisfied.
2. **Explicit corrections:** An explicit user-correction reason may be emitted only after its mapping, active-state semantics, precedence, lifetime, and undo behavior are Founder-approved. `USER_NOT_IMPORTANT` remains registered but non-operative until PPV1-026 and its dependencies are approved.
3. **Supporting reasons:** A reason associated with a lower individually assigned tier may remain visible when a higher tier wins. Supporting reasons must not be represented as though each one independently determined the final tier.
4. **Prohibited negative inference:** Never emit reasons inferred from absent signals or passive negative conclusions. Prohibited examples include:
   - `NOT_STARRED`
   - `NOT_RECENT`
   - `NOT_IMPORTANT`
   - `SAFE_TO_IGNORE`
   - `NO_ATTENTION_NEEDED`

   Absence of evidence shall not become negative evidence.
5. **Ordering and deduplication:** Reasons shall be deduplicated and ordered under PPV1-018.
6. **Recency:** `RECENCY` remains registered but inactive and shall not be emitted under the currently approved policy.

Implementations must not derive user-facing text from enum names. Codes and wording are separate contract fields.

## 8. Ordering rules

Candidate ordering must be stable and fully deterministic. Database row order, provider response order, object-property order, locale defaults, and asynchronous completion order must never affect the result.

- **PPV1-020 — Tier ordering:** TODO (Founder Approval Required): Define the descending order of approved tiers.
- **PPV1-021 — Within-tier comparator:** TODO (Founder Approval Required): Define the complete sequence of within-tier tie-breakers.
- **PPV1-022 — Final identity tie-breaker:** TODO (Founder Approval Required): Approve the stable final identifier used when all policy evidence and timestamps are equal.
- **PPV1-023 — Missing timestamp ordering:** TODO (Founder Approval Required): Define where candidates without a valid activity timestamp appear.

Until these decisions are approved, an ordered multi-candidate Attention response must not be implemented.

## 9. Future timestamp handling

The mailbox projection preserves a valid provider timestamp unchanged so repeated synchronization remains deterministic.

During evaluation, if a provider timestamp is later than the fixed `evaluatedAt` instant, the calculated age is clamped to zero. A future timestamp must never create a negative age or additional priority beyond the approved rule for an age of zero.

The evaluator must not rewrite the persisted provider timestamp and must not use the current system clock implicitly.

- **PPV1-024 — Excessive future skew:** TODO (Founder Approval Required): Define whether a timestamp beyond a specific future-skew tolerance remains eligible, is treated as missing, or produces a diagnostic condition.

## 10. User overrides

Priority Policy v1 reserves three user correction intents:

- Prioritize
- Not Important
- Undo

User Override means only an explicit action intentionally performed by the user.

Behavioral inference, usage history, reopening frequency, hover duration, AI prediction, or similar inferred behavior shall not constitute a User Override.

Corrections must be:

- owner-scoped;
- reversible;
- explicit;
- independent of Gmail labels;
- applied without silently mutating Gmail.

The persistence and product workflow for corrections are outside the current implementation task. Policy behavior remains unresolved:

- **PPV1-025 — Prioritize mapping:** TODO (Founder Approval Required): Define the exact tier and reason produced by a Prioritize override.
- **PPV1-026 — Not Important mapping:** TODO (Founder Approval Required): Define the exact tier and reason produced by a Not Important override.
- **PPV1-027 — Override precedence:** TODO (Founder Approval Required): Define how each override interacts with every automated signal and tier.
- **PPV1-028 — Override lifetime:** TODO (Founder Approval Required): Define whether corrections expire, survive archive/read changes, or remain until Undo.
- **PPV1-029 — Undo semantics:** TODO (Founder Approval Required): Define the state restored by Undo and whether historical correction records remain auditable.

## 11. Freshness policy

An evaluation is a statement about a specific normalized projection at a specific `evaluatedAt` instant. It must not be presented as current after its inputs become stale.

- **PPV1-030 — Evaluation validity interval:** TODO (Founder Approval Required): Define the maximum age of an evaluation before it must be recalculated.
- **PPV1-031 — Recalculation triggers:** TODO (Founder Approval Required): Approve the complete trigger set, including synchronization changes, Gmail label changes, timestamp-window changes, and user corrections.
- **PPV1-032 — Stale presentation:** TODO (Founder Approval Required): Define whether stale results may be shown with disclosure or must be withheld.
- **PPV1-033 — Cache policy:** TODO (Founder Approval Required): Define cache identity, maximum lifetime, and invalidation requirements.

An implementation must always expose `evaluatedAt` and `policyVersion`. Cached evaluations must be scoped to the authenticated owner and exact policy inputs.

## 12. Attention Contract v1

The evaluation contract is a pure data contract. It does not define an HTTP route, database schema, persistence model, or background job.

At minimum, one evaluated candidate returns:

```text
threadId
tier
reasonCodes
reasons
policyVersion
evaluatedAt
```

Contract invariants:

- `threadId` is the application's owner-scoped thread identifier, not a raw provider payload.
- `tier` is one approved tier identifier.
- `reasonCodes` is an ordered list of approved stable identifiers.
- `reasons` is an ordered list of approved human-readable strings corresponding one-to-one with `reasonCodes`.
- `policyVersion` is `1.0`.
- `evaluatedAt` is the caller-supplied fixed instant used for the complete evaluation.
- No confidence score, inferred urgency, raw Gmail response, message content, or hidden diagnostic is returned.
- Identical normalized input and identical `evaluatedAt` produce an identical evaluation object.

Unresolved contract decisions:

- **PPV1-034 — Candidate-scope disclosure:** TODO (Founder Approval Required): Define the exact structured `candidateScope` representation returned with a collection evaluation.
- **PPV1-035 — Collection envelope:** TODO (Founder Approval Required): Define the collection-level fields needed to truthfully describe bounded coverage, synchronization freshness, and ordering.

### PPV1-036 — No-reason representation

Empty `reasonCodes` and `reasons` arrays are permitted only for the `NO_IMMEDIATE_SIGNALS` tier when no affirmative constitutional evidence exists.

The evaluator must not fabricate synthetic evidence. Absence of affirmative evidence shall not itself become affirmative evidence.

### PPV1-037 — Contract timestamp format

All constitutional timestamps use RFC 3339 UTC serialization with millisecond precision.

The canonical format is:

```text
YYYY-MM-DDTHH:mm:ss.sssZ
```

The `evaluatedAt` output shall conform exactly to this canonical representation.

## 13. UX contract

The interface must:

- use calm, honest language;
- explain the evidence behind every recommendation;
- distinguish evidence from certainty;
- avoid exaggerated confidence;
- disclose bounded or stale candidate scope;
- leave the final judgment with the user;
- make correction and Undo behavior understandable;
- remain accessible by keyboard and assistive technology.

The interface must not:

- claim that the policy understands message content or intent;
- imply that lower-tier mail is unimportant in an absolute sense;
- use anxiety-inducing urgency language without explicit approved evidence;
- conceal why a thread was included;
- silently change Gmail labels.

- **PPV1-038 — Tier display labels:** TODO (Founder Approval Required): Approve exact user-facing tier names.
- **PPV1-039 — Empty-state copy:** TODO (Founder Approval Required): Approve wording for no candidates, stale synchronization, and unavailable evaluation states.
- **PPV1-040 — Scope disclosure copy:** TODO (Founder Approval Required): Approve how bounded candidate coverage is communicated.
- **PPV1-041 — Correction copy:** TODO (Founder Approval Required): Approve user-facing wording for Prioritize, Not Important, and Undo outcomes.

## 14. Non-goals

Priority Policy v1 does not include:

- AI or LLM classification;
- prompts or generated explanations;
- semantic analysis;
- message-body intelligence;
- snippet analysis;
- attachment-content analysis;
- inferred relationships;
- inferred deadlines, intent, sentiment, or urgency;
- contact intelligence;
- automatic Gmail label modification;
- automatic archive, send, reply, forward, or notification actions;
- a full-mailbox completeness claim;
- confidence scoring;
- hidden ranking weights;
- personalized learning.

## 15. Success metrics

Success must measure whether the policy reduces uncertainty and earns trust, not whether it maximizes engagement.

- **PPV1-042 — Time-to-first-action target:** TODO (Founder Approval Required): Approve the target and measurement protocol.
- **PPV1-043 — Correction-rate interpretation:** TODO (Founder Approval Required): Define the metric, observation window, and acceptable range without treating every correction as failure.
- **PPV1-044 — Explanation usefulness:** TODO (Founder Approval Required): Define the research question and success threshold.
- **PPV1-045 — Trust measure:** TODO (Founder Approval Required): Define the qualitative or quantitative release criterion for user trust.
- **PPV1-046 — Operational correctness:** TODO (Founder Approval Required): Approve measurable targets for deterministic replay, stale-result prevention, and policy-version reporting.

Metrics must not collect message bodies, recipient content, or other mailbox content solely for Priority Policy analytics.

## 16. Known risks

1. A bounded candidate set can omit mail that matters to the user.
2. Gmail labels express provider and user state, not objective importance.
3. Unread status does not necessarily mean attention is required.
4. Recency can overemphasize new mail and underemphasize older unresolved work.
5. Normalized sender, recipient, and attachment metadata does not reveal intent.
6. Provider timestamps may be missing, malformed, or future-dated.
7. Synchronization lag can make an otherwise correct evaluation stale.
8. Personal preferences differ; deterministic defaults will require reversible correction.
9. Incomplete policy TODOs prevent a conforming executable implementation.

These risks must be represented honestly in product review and validation. They must not be concealed through confidence language.

## 17. Future evolution

Future versions may consider personal learning, relationship modeling, deadline extraction, or AI assistance only after evidence demonstrates a user need and Wong Studio approves a new versioned policy.

Future possibilities are not Sprint 1 commitments. They must not be introduced under the Priority Policy v1 identifier.

Any evolution must:

- preserve owner control and reversibility;
- maintain an explanation contract;
- distinguish observed evidence from inference;
- receive explicit Founder approval;
- increment the policy version when behavior changes;
- include a migration and compatibility decision for prior evaluations.

## 18. Founder approval record

Approved by:

Founder

Sprint:

Sprint 1

Decision:

Approved as the engineering source of truth for Priority Policy v1 and Attention Contract v1.

Founder directive:

FD-001

Approval date:

**PPV1-047 — Approval date:** TODO (Founder Approval Required)

Approval boundary:

The document structure, philosophy, design promise, deterministic/non-AI boundary, normalized-metadata boundary, future-age clamping rule, correction principles, Attention Contract minimum fields, non-goals, and source-of-truth role are approved. Numbered TODOs are explicit unresolved decisions and are not authorization to implement behavior.

## 19. Revision history

| Version | Status | Date | Decision owner | Change |
| --- | --- | --- | --- | --- |
| 1.0 | Approved amendment | 2026-07-24 | Founder | Recorded Founder Design Session #5 contract vocabulary decisions for tier identifiers, evidence-specific reason codes, localized canonical reasons, reason precedence, empty-reason representation, and canonical timestamps. |
| 1.0 | Approved amendment | 2026-07-24 | Founder | Recorded Founder Design Session #4 decisions defining Recency as objective temporal evidence, prohibiting tier promotion from Recency alone, preserving explicit user-intent precedence, and permitting Recency only as a deterministic tie-breaker when candidates are otherwise constitutionally equal. |
| 1.0 | Approved amendment | 2026-07-24 | Founder | Recorded Founder Design Session #3 decisions for Manual user star, provider-verifiable signal origin, missing-metadata fallbacks, candidate-count scalability, provider neutrality, explicit User Override, and AI independence. |
| 1.0 | Approved | Pending PPV1-047 | Founder | Established the repository source of truth under FD-001. Unresolved policy decisions are enumerated for Founder review before executable implementation. |

Changes to operative policy require:

1. an explicit Founder decision;
2. an update to this document;
3. a revision-history entry;
4. a policy-version compatibility decision;
5. regression tests proving the approved behavior.
