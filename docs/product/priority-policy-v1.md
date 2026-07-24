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

- **PPV1-001 — Eligible Gmail location:** Current Inbox membership defines constitutional location eligibility.

  A thread is location-eligible when:

  - its normalized current location includes verified Inbox membership; and
  - it is not currently located in Spam or Trash.

  Approved behavior:

  - Current Inbox thread → eligible
  - Archived thread without Inbox membership → ineligible
  - Sent-only thread → ineligible
  - Draft-only thread → ineligible
  - Spam thread → ineligible
  - Trash thread → ineligible
  - Inbox thread that also contains sent messages → remains eligible
  - Inbox thread that also contains a draft → remains eligible

  Eligibility is determined by the thread's current normalized location membership. Sent or Draft participation within a conversation does not disqualify an otherwise eligible Inbox thread.

  Priority Policy v1 does not evaluate archived-only mail, Sent-only conversations, Draft-only conversations, Spam, or Trash.

  This decision governs location eligibility only. Lookback duration, candidate timestamps, missing-label handling, synchronization readiness, and provider mappings remain governed by separate Founder decisions.

  The constitutional policy consumes provider-neutral normalized location membership; Gmail-specific labels remain adapter concerns.
- **PPV1-002 — Maximum candidate count:** The policy defines no maximum candidate count. Implementations may batch, paginate, stream, parallelize, or otherwise optimize evaluation provided every eligible candidate remains eligible for deterministic evaluation.
  - **PPV1-002A — Time-to-first-result guarantee:** TODO (Founder Approval Required): Define the maximum permitted time before the first eligible deterministic result is available.
  - **PPV1-002B — Candidate lookback duration:** Priority Policy v1 establishes no temporal lookback limit. Every thread satisfying PPV1-001 location eligibility remains constitutionally eligible regardless of age.

    Priority Policy v1 defines no age-based eligibility cutoff and no maximum candidate count. Constitutional eligibility is determined independently of implementation strategy.

    Batching, pagination, streaming, parallelization, caching, and progressive delivery shall never redefine candidate eligibility.

    Recency affects deterministic ordering only and never determines eligibility. Users naturally control candidate scope through current Inbox membership. Archived-only threads remain governed by PPV1-001 and remain outside the candidate set.

    PPV1-002A remains a separate operational guarantee.
- **PPV1-003 — Candidate timestamp:** The candidate timestamp is the latest valid provider-confirmed timestamp from a verifiably incoming message in the thread.

  1. **Incoming activity:** A newly received incoming message may advance the candidate timestamp.
  2. **User-authored activity:** Sent replies, draft creation, draft updates, and other owner-authored message activity shall not advance the candidate timestamp.
  3. **Provider and local metadata:** Provider history identifiers, synchronization timestamps, watch-renewal timestamps, local `created_at` timestamps, local `updated_at` timestamps, and projection-write timestamps are not candidate timestamps.
  4. **Verified direction:** Message direction must come from provider-verifiable normalized metadata. If direction cannot be verified, the implementation shall not infer that the message is incoming.
  5. **Missing timestamp:** If no valid incoming-message timestamp exists, the candidate timestamp is missing. PPV1-004A and PPV1-023 govern the resulting behavior.
  6. **No synthesis:** The implementation shall not synthesize a candidate timestamp from unrelated or locally generated fields.
  7. **Future timestamps:** Future timestamp handling remains governed by the existing age-zero rule and PPV1-024.

  The candidate timestamp affects deterministic ordering and future approved temporal rules only. It does not affect eligibility under PPV1-002B.
- **PPV1-004 — Missing metadata fallback:** Missing metadata must never be inferred. Each missing field follows the approved deterministic behavior below.

  | Missing Metadata | Deterministic Behavior | Founder Status |
  | --- | --- | --- |
  | Candidate timestamp (`PPV1-004A`) | Retain the candidate with an Unknown temporal state; apply no temporal effect. | Approved |
  | Sender (`PPV1-004B`) | Preserve independent Unknown states for display name and address; apply no policy effect. | Approved |
  | Labels (`PPV1-004C`) | Preserve independent verified-present, verified-absent, or Unknown states; evaluate only rules whose required label evidence is verified. | Approved |
  | User overrides (`PPV1-004D`) | Preserve verified-active-present, verified-active-absent, or Unknown state; evaluate only rules whose required override evidence is verified. | Approved |

### PPV1-004A — Missing candidate timestamp

When an otherwise eligible candidate has no valid PPV1-003 candidate timestamp:

1. **Candidate retention:** The candidate remains constitutionally eligible under PPV1-001 and PPV1-002B.
2. **Unknown temporal state:** The candidate timestamp remains missing. No replacement timestamp may be generated, inferred, copied, or synthesized. Prohibited substitutes include:
   - zero or epoch time;
   - `evaluatedAt`;
   - current time;
   - synchronization time;
   - local insertion time;
   - local update time;
   - another unrelated timestamp.
3. **Available evidence:** All other available approved constitutional rules continue to evaluate normally. A Manual Star may still assign `REVIEW_LATER`. Future approved user corrections may still apply.
4. **No temporal effect:** A missing candidate timestamp:
   - produces no Recency effect;
   - emits no `RECENCY` reason;
   - does not promote or demote a tier;
   - does not itself assign `NO_IMMEDIATE_SIGNALS`.

   If no other applicable rule assigns a higher tier, PPV1-009 independently assigns `NO_IMMEDIATE_SIGNALS` with empty reasons.
5. **Ordering:** PPV1-023 remains the sole authority for deterministic placement of candidates with missing timestamps. PPV1-004A shall not resolve that ordering decision.
6. **Truthful disclosure:** A collection containing one or more candidates with missing candidate timestamps shall disclose incomplete temporal evidence through the future PPV1-035 collection envelope. PPV1-035 remains responsible for the exact field names, shape, and serialization.

Tier evaluation may remain constitutionally valid when temporal evidence is incomplete. The disclosure communicates the limitation affecting temporal comparison and presentation; it does not imply that every tier result is invalid.

### PPV1-004B — Missing sender

Priority Policy v1 adopts independent Unknown states for sender display name and sender address.

1. **Candidate retention:** Missing or malformed sender metadata shall never exclude an otherwise eligible candidate.
2. **Independent normalization:** Sender display name and sender address are evaluated independently. Each field preserves its own verified state. A missing or malformed field does not invalidate another independently verified field.
3. **Unknown preservation:** Missing or malformed sender fields remain Unknown. No identity may be guessed, synthesized, inferred, or fabricated. Prohibited substitutions include:
   - `"Unknown Sender"` as factual identity;
   - mailbox-owner identity;
   - empty address as verified address;
   - guessed email addresses;
   - malformed provider values treated as normalized identity.
4. **No constitutional evaluation effect:** Missing sender metadata:
   - does not affect eligibility;
   - does not affect ordering;
   - does not assign or modify tiers;
   - emits no reasons;
   - provides no affirmative or negative evidence.
5. **Presentation:** Presentation layers may display neutral interface text indicating unavailable sender information. Presentation fallback is interface copy only. It is not normalized sender identity, constitutional evidence, or provider metadata.
6. **Collection disclosure:** Because sender is non-operative in Priority Policy v1, missing sender metadata requires no collection-level incomplete-evidence disclosure. Future sender-based constitutional rules remain governed by PPV1-015 and future amendments.

### PPV1-004C — Missing labels

Priority Policy v1 adopts independent three-state knowledge for every normalized constitutional label concept:

- verified present;
- verified absent;
- Unknown.

1. **Candidate retention:** Missing, incomplete, malformed, or unavailable policy-evidence labels shall not exclude an otherwise PPV1-001-eligible candidate.
2. **Independent label state:** Each normalized label concept preserves its own independently verified state. An Unknown or malformed label does not invalidate another independently verified label.
3. **Unknown preservation:** A label is Unknown unless an authoritative provider-normalized result verifies its presence or absence. Unknown shall never be serialized or evaluated as:
   - `false`;
   - absent;
   - an empty label set;
   - no Manual Star;
   - no Inbox membership;
   - no future mapped provider signal.
4. **Label-dependent rules:** A label-dependent rule evaluates only when its required label condition is verified. For Manual Star:
   - verified present → apply PPV1-011 and emit `MANUAL_STAR`;
   - verified absent → Manual Star does not apply;
   - Unknown → do not evaluate Manual Star and emit no `MANUAL_STAR` reason.
5. **Label-independent rules:** All approved rules that do not depend on unavailable label evidence continue to evaluate normally.
6. **Default tier:** If no available approved rule assigns a higher tier, PPV1-009 may independently assign `NO_IMMEDIATE_SIGNALS`. That result shall not be represented as proof that Manual Star was absent when its state was Unknown.
7. **Disclosure:** Because incomplete label metadata can prevent evaluation of an operative constitutional signal, a collection containing affected candidates shall disclose incomplete label evidence through PPV1-035. PPV1-035 remains responsible for the exact public field names, shape, and serialization.
8. **Recalculation:** When authoritative label metadata becomes available or changes, the candidate shall be reevaluated under the future PPV1-031 trigger rules.

PPV1-004C governs policy-evidence label availability after location eligibility has otherwise been established. It does not authorize synthesis of Inbox membership or any other provider mapping.

### PPV1-004D — Missing user override metadata

Priority Policy v1 adopts three-state knowledge for owner-scoped user-override metadata:

- verified active override present;
- verified active override absent;
- Unknown.

1. **Verified presence:** An override is present only when a valid authoritative owner-scoped record confirms an active explicit user correction. Active corrections remain non-operative until PPV1-025 through PPV1-029 approve their mapping, precedence, lifetime, and Undo semantics.
2. **Verified absence:** Override absence is established only when a successful authoritative owner-scoped lookup confirms that no active override exists.
3. **Unknown state:** The following produce Unknown:
   - failed lookup;
   - unavailable storage;
   - incomplete metadata;
   - malformed metadata;
   - ambiguous state;
   - unverifiable activity.

   Unknown shall never be interpreted as:

   - no active correction;
   - not prioritized;
   - not marked Not Important;
   - an inferred Undo;
   - an empty override treated as verified absence.
4. **Candidate retention:** Missing, unavailable, incomplete, or malformed override metadata shall not exclude an otherwise eligible candidate.
5. **Partial evaluation:** When override state is Unknown:
   - override-dependent rules do not evaluate;
   - every approved override-independent rule continues to evaluate normally.
6. **Default tier:** If no available approved rule assigns a higher tier, PPV1-009 may independently assign `NO_IMMEDIATE_SIGNALS`. That result shall not be represented as proof that no active user correction exists.
7. **Disclosure:** Because Unknown override metadata may conceal the highest-authority constitutional input, a collection containing affected candidates shall disclose incomplete user-correction evidence through PPV1-035. PPV1-035 remains responsible for the exact public fields, shape, and serialization.
8. **Recalculation:** When authoritative override state becomes available or changes, the candidate shall be reevaluated under PPV1-031.

Tier evaluation may proceed from available evidence while override metadata is Unknown, but the result must remain truthfully qualified through collection-level disclosure.

- **PPV1-005 — Synchronization requirement:** Priority Policy v1 adopts an explicit synchronization-readiness boundary with truthful partial-result support.

  1. **Synchronization-ready:** A collection may be described as synchronization-ready only when an authoritative synchronization checkpoint establishes complete PPV1-001 candidate-location coverage for the normalized snapshot being evaluated. All known provider changes through that checkpoint must be durably reflected or explicitly represented as unresolved.
  2. **Partial synchronization:** Deterministic evaluation may proceed for candidates already represented in a partial snapshot. Partial results may be presented only when explicitly identified as partial. They shall never be described as:
     - complete candidate coverage;
     - current complete mailbox evaluation;
     - evidence that every eligible candidate was evaluated.
  3. **Eligibility preservation:** Partial synchronization does not make undiscovered candidates ineligible. Batching, pagination, streaming, parallelization, and progressive delivery shall not redefine PPV1-001 or PPV1-002B.
  4. **Evidence completeness:** Missing timestamp, label, or override evidence within a known candidate does not automatically make candidate coverage synchronization-unready. Those field-level limitations remain governed by PPV1-004 and disclosed separately through PPV1-035.
  5. **Freshness separation:** Synchronization readiness establishes coverage integrity at a checkpoint. It does not establish how long that checkpoint may be called current. PPV1-030 through PPV1-033 remain responsible for validity, recalculation, stale presentation, and caching.
  6. **Provider unavailability:** A previously synchronization-ready snapshot does not become partial solely because the provider becomes temporarily unavailable. Whether that snapshot may still be presented, and whether it may be called current, remains governed by future freshness and stale-presentation rules.
  7. **Collection disclosure:** PPV1-035 shall distinguish:
     - synchronization-ready coverage;
     - partial synchronization coverage;
     - field-level incomplete evidence.

     The exact public field names, shape, and serialization remain governed by PPV1-035.

  The evaluator may produce a valid deterministic result over the exact inputs supplied while the collection remains partial. Validity of an individual deterministic calculation does not imply complete candidate coverage.
- **PPV1-006 — Empty candidate behavior:** Priority Policy v1 adopts status-qualified empty collections.

  1. **Synchronization-ready empty evaluation:** A collection may state that it contains zero eligible candidates only when:
     - PPV1-005 synchronization-ready coverage is established;
     - the complete PPV1-001 candidate scope is represented at the authoritative checkpoint;
     - zero candidates satisfy that scope; and
     - applicable freshness and stale-presentation rules permit the snapshot to be presented as current.
  2. **Constitutional meaning:** A synchronization-ready empty result means only:

     > No candidates satisfy the approved Priority Policy candidate scope in this synchronization-ready snapshot.

     It shall not mean or imply:

     - the mailbox is empty;
     - no email is important;
     - no email requires human judgment;
     - archived mail is empty;
     - Sent is empty;
     - Drafts are empty;
     - Spam is empty;
     - Trash is empty;
     - the user has no work.
  3. **Partial synchronization:** Zero currently represented candidates in a partial snapshot is a partial empty result. It is not proof that zero eligible candidates exist. It must remain explicitly identified as partial.
  4. **Provider unavailable or stale:** Provider unavailability and stale coverage are not empty candidate results. PPV1-032 remains responsible for whether a previously ready snapshot may remain visible.
  5. **Contract behavior:** Return an empty candidate collection together with truthful:
     - readiness metadata;
     - freshness metadata;
     - candidate-scope metadata;
     - evidence-completeness metadata.

     PPV1-034 and PPV1-035 remain responsible for exact public representation. Do not create:

     - fabricated candidates;
     - synthetic reasons;
     - transport-level absence as a substitute for constitutional state.
  6. **Presentation:** PPV1-039 remains responsible for exact user-facing wording for synchronization-ready empty, partial empty, stale, and unavailable states.

  The evaluator may deterministically return zero items for the exact inputs supplied. That fact alone does not prove complete candidate coverage or mailbox emptiness.

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

Tier assignment must be deterministic. The engine must not emit confidence, inferred urgency, or an unapproved intermediate tier. PPV1-020 is authoritative for the constitutional ordering of the approved identifiers.

## 6. Deterministic rule set

The evaluator may consume only normalized metadata already available from the mailbox projection and explicitly approved in this section.

Available normalized evidence includes:

- Gmail system-label presence, including `UNREAD`, `STARRED`, `IMPORTANT`, and `INBOX`
- normalized candidate timestamp defined by PPV1-003
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

- **PPV1-020 — Tier ordering:** Priority Policy v1 adopts the following strict descending constitutional tier order:
  1. `NEEDS_ATTENTION`
  2. `REVIEW_LATER`
  3. `NO_IMMEDIATE_SIGNALS`

  1. **Tier ordering:** The above order is the sole constitutional ordering of approved tiers. No implementation shall derive ordering from:
     - declaration order;
     - enum values;
     - numeric values;
     - scores;
     - weights;
     - confidence;
     - heuristics;
     - implementation-specific ordering.
  2. **Conflict resolution:** After individual rule evaluation and any applicable correction handling under PPV1-025 through PPV1-027, PPV1-012 shall select the highest tier according to this constitutional order.
  3. **No accumulation:** Multiple assigned tiers shall never accumulate or promote beyond the highest tier actually assigned by an approved constitutional rule.
  4. **Collection grouping:** Primary collection grouping shall follow this constitutional tier order. Candidates within the same final tier remain governed exclusively by PPV1-021.
  5. **Separation of concerns:** This ordering governs only:
     - constitutional tier ordering;
     - final-tier conflict resolution;
     - primary collection grouping.

     It shall not define:

     - rule precedence;
     - reason ordering;
     - within-tier ordering;
     - urgency;
     - objective importance;
     - certainty;
     - confidence;
     - required action.
  6. **Future compatibility:** Any future Founder-approved tier shall require explicit placement within the constitutional ordering before implementation.

  This ordering makes the approved tier semantics executable. It does not redefine those semantics.
- **PPV1-021 — Within-tier comparator:** Priority Policy v1 adopts the following lexicographic within-tier comparator. This comparator applies only after final tier assignment and primary tier grouping under PPV1-020.

  1. **Timestamp availability:** Apply PPV1-023 to determine the placement of candidates whose PPV1-003 candidate timestamp is missing relative to candidates with valid timestamps. PPV1-021 does not resolve that placement.
  2. **Effective candidate timestamp:** For ordering only, derive the effective timestamp using the caller-supplied fixed `evaluatedAt`:
     - candidate timestamp at or before `evaluatedAt` → use the verified candidate timestamp;
     - candidate timestamp after `evaluatedAt` → use `evaluatedAt`, preserving the approved age-zero treatment.

     This evaluation-only comparison key shall not rewrite, normalize, or replace the persisted provider-confirmed timestamp.
  3. **Temporal direction:** Among candidates with valid effective timestamps, sort in descending order:
     - newest verified incoming work first;
     - older verified incoming work later.
  4. **Final identity tie-breaker:** When effective timestamps are equal, apply the PPV1-022 stable identity comparator.
  5. **Prohibited comparators:** Within-tier ordering shall not use:
     - sender;
     - subject;
     - recipients;
     - attachment state;
     - reason count;
     - rule count;
     - label count;
     - provider response order;
     - synchronization order;
     - database row order;
     - insertion order;
     - local created or updated timestamps;
     - scores;
     - weights;
     - confidence;
     - AI inference.
  6. **Constitutional boundaries:** The within-tier comparator:
     - does not affect eligibility;
     - does not assign or change tiers;
     - does not create reasons;
     - does not alter rule precedence;
     - does not imply importance, urgency, or required action.
  7. **Deterministic replay:** Identical constitutional candidate inputs and an identical `evaluatedAt` shall produce identical ordering.

  PPV1-024 remains responsible for excessive future-skew policy. This decision applies only the already approved age-zero treatment to the ordering comparison key and does not resolve PPV1-024's remaining behavior.
- **PPV1-022 — Final identity tie-breaker:** Priority Policy v1 uses the immutable owner-scoped application `threadId` as the final non-semantic tie-breaker.

  1. **Identity:** `threadId` shall be:
     - application-owned;
     - owner-scoped;
     - immutable for the lifetime of the logical thread projection;
     - provider-neutral;
     - distinct from any raw provider identifier.
  2. **Comparator:** Compare `threadId` values using their canonical UUID 16-byte representation in unsigned ascending byte order. The implementation shall not use:
     - locale-sensitive string comparison;
     - database default collation;
     - case folding;
     - provider identifier ordering;
     - insertion order;
     - synchronization order;
     - database row order;
     - runtime iteration order.
  3. **Comparator position:** The `threadId` comparator runs only after PPV1-020 tier ordering and every preceding PPV1-021 within-tier comparison are equal.
  4. **No semantic meaning:** The `threadId` value carries no constitutional or user-facing meaning. It shall not affect:
     - eligibility;
     - tier assignment;
     - reasons;
     - rule precedence;
     - timestamp ordering;
     - importance;
     - urgency.
  5. **Stability:** The application shall preserve the same owner-scoped `threadId` across ordinary synchronization and projection updates.
  6. **Invalid input:** An absent or malformed constitutional `threadId` is invalid evaluator input. The evaluator shall fail safely. It shall not:
     - generate a replacement UUID;
     - fall back to a provider ID;
     - derive an identity from sender or subject;
     - use database or runtime ordering.

  PPV1-022 exists solely to complete a deterministic total order when all higher-order constitutional comparators are equal.
- **PPV1-023 — Missing timestamp ordering:** Priority Policy v1 requires candidates with verified PPV1-003 timestamps to appear before candidates with Unknown timestamps within the same final tier.

  1. **Tier authority:** PPV1-020 tier grouping remains the primary collection order. Timestamp availability shall never move a candidate across tiers.
  2. **Verified temporal evidence:** Within the same final tier, candidates with valid PPV1-003 timestamps appear first. They are ordered under PPV1-021:
     - effective candidate timestamp descending;
     - PPV1-022 `threadId` comparator when effective timestamps are equal.
  3. **Unknown temporal evidence:** Candidates whose PPV1-003 timestamp is Unknown appear after timestamped candidates within the same tier. Unknown-timestamp candidates are ordered solely by the PPV1-022 `threadId` comparator.
  4. **Unknown preservation:** The implementation shall not synthesize or substitute:
     - epoch time;
     - current time;
     - `evaluatedAt`;
     - synchronization time;
     - insertion time;
     - local persistence time;
     - any unrelated timestamp.
  5. **No semantic implication:** Placement after timestamped peers shall not mean or imply that an Unknown-timestamp candidate is:
     - older;
     - less important;
     - lower priority;
     - less urgent;
     - safe to ignore.

     The placement exists only because verified chronological comparison is unavailable.
  6. **Disclosure:** Collections containing Unknown candidate timestamps shall disclose incomplete temporal evidence through PPV1-035. The exact field names, shape, serialization, and user-facing presentation remain governed by PPV1-035 and related UX decisions.
  7. **Future skew:** PPV1-024 remains responsible for determining whether excessively future-skewed timestamps continue to count as valid temporal evidence.

  PPV1-023 completes deterministic ordering without assigning chronology to Unknown evidence.

## 9. Future timestamp handling

The mailbox projection preserves a valid provider timestamp unchanged so repeated synchronization remains deterministic.

During evaluation, if a provider timestamp is later than the fixed `evaluatedAt` instant, the calculated age is clamped to zero. A future timestamp must never create a negative age or additional priority beyond the approved rule for an age of zero.

The evaluator must not rewrite the persisted provider timestamp and must not use the current system clock implicitly.

- **PPV1-024 — Excessive future skew:** Priority Policy v1 defines a single explicit future-skew tolerance parameter.

  **Future-skew tolerance duration:** TODO (Founder Approval Required): Approve the exact duration. The implementation shall not invent, default, or hard-code a duration before that approval.

  1. **Within tolerance:** A valid provider-confirmed candidate timestamp later than `evaluatedAt` but not beyond the approved future-skew tolerance remains valid temporal evidence. For PPV1-021 ordering, its effective timestamp is `evaluatedAt`. The original provider timestamp remains unchanged.
  2. **Beyond tolerance:** A candidate timestamp strictly later than `evaluatedAt` plus the approved tolerance is excessive future skew. For constitutional temporal evaluation, it becomes Unknown.
  3. **Candidate behavior:** Excessive future skew:
     - does not affect eligibility;
     - does not assign or change a tier;
     - emits no reason;
     - does not rewrite provider metadata.

     PPV1-023 governs within-tier placement.
  4. **Disclosure:** Collections containing excessive-future-skew candidates shall disclose incomplete temporal evidence through PPV1-035.
  5. **Recalculation:** PPV1-031 shall govern reevaluation when:
     - `evaluatedAt` advances;
     - provider timestamp metadata changes; or
     - the approved tolerance changes in a future policy version.
  6. **Boundary semantics:** Once the duration is approved:
     - timestamps at exactly `evaluatedAt` plus the tolerance remain valid;
     - timestamps strictly beyond that boundary become Unknown.

  The constitutional excessive-future-skew rule is approved. The exact future-skew tolerance duration remains unresolved and must not be inferred.

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
