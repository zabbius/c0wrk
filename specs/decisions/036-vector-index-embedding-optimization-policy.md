# ADR-036: Vector-Index Embedding Optimization Integration Policy

## Status

Accepted

## Context

The 2026-09 vector-index optimization cycle evaluated a series of candidate optimizations across both repositories, each behind a checked-in benchmark gate (`core/vectorindex/BENCHMARKS.md` in c0wrk, benchmark-decision sections of `specs/domains/embedding.md` in sp4rk):

- **c0wrk (host)**: streaming batch accumulator with commit windows, content-addressed embedding cache with deduplication, deterministic pre-chunk content filter, ONNX intra-op thread cap.
- **sp4rk (SDK)**: fixed-shape persistent ONNX sessions, opt-in length buckets, opt-in tokenization/inference batch pipeline, benchmark-only parallel-session grid and dynamic-shape evaluation.

Every candidate carried a go/no-go threshold measured on reproducible corpora (isolated processes, medians, joint acceptance on throughput + CPU + query latency + peak RSS). The cycle ended with a mix of confirmed optimizations, gate-locked opt-ins, and two NO-GO verdicts. Without a recorded policy, the next contributor faces three recurring questions: which of these are actually on in production, who owns which layer, and what it takes to flip a default.

## Decision

1. **Integrated and on by default (automatic mode, no host knobs).**
   - c0wrk: the streaming batch accumulator (only the final inference of an indexing pass may be underfilled; chromem commits in ≤200-document windows; a file's sidecar entry publishes only after all its chunks commit), the content-addressed embedding cache (`vector_index.embedding_cache_max_bytes`, default 512 MiB, negative disables; rename/branch/move reuse; corruption is a fail-open miss), and the content filter (`vector_index.content_filter.*`, default-on policy that feeds the chunker fingerprint).
   - sp4rk defaults consumed automatically: persistent fixed-shape sessions (eager batch-1 query session, lazy `[BatchSize, MaxSeqLength]` persistent batch session with zero-padded tails), idempotent `Close` serialized with inference, and `IntraOpThreads` surfaced as `vector_index.embedding_threads` (0 = all cores, the legacy behavior).

2. **Gated OFF in the SDK — opt-in flags that c0wrk does not surface as configuration.** `EnableLengthBuckets` (mixed-corpus peak RSS regression keeps fixed-512 the default) and `EnableBatchPipeline` (+0.64–1.25% < the 5% noise threshold) remain SDK opt-ins. This is deliberate: prefer one automatic production profile over a matrix of public knobs whose trade-offs (RSS vs. wall time on short corpora) users cannot evaluate from a config file.

3. **NO-GO (benchmark-only, checked in for re-evaluation).** Embedding↔persistence pipelining (ceiling ~1.5% wall < the 10% gate) and parallel ONNX sessions (workers=2: query p95 +39% worse, ~2× peak RSS, ~2× CPU draw on a shared desktop) stay out of production paths.

4. **Layering contract.** Generic ONNX logic — session lifecycle, shape/bucket policy, inference pipeline, runtime telemetry — lives in `sp4rk/embedding`, which owns no vector store and no persistence. Embedding persistence and policy — the content-addressed cache, commit windows, fingerprints, project containment — live in `c0wrk/core/vectorindex`, which never imports the ONNX runtime directly. A host knob is added only when it expresses a genuine user-facing trade-off (CPU ceiling, disk cap); inference-strategy choices stay behind SDK gates.

5. **Compatibility and flip conditions.** Configs written before the cycle load unchanged: absent keys resolve to the historical inference behavior (batch 32 = sp4rk's historical default, threads 0 = all cores, cache cap 512 MiB is additive) with the content filter's default-on policy as the single documented semantic delta — pinned by `TestVectorIndexConfig_LegacyYAMLCompat`. Flipping any gated default (buckets, pipeline, parallel sessions) requires a new checked-in benchmark decision in the owning repository's spec plus the matching `BENCHMARKS.md` update — never a host-side flag flip.

## Consequences

**Positive:**

- One automatic production profile; the desktop resource envelope (single ONNX session, bounded commit windows, capped cache) is predictable.
- Gate verdicts and their re-evaluation conditions are recorded in-repo, so future hardware or model changes have a defined path back.
- Cross-repo ownership is explicit: ONNX stays in sp4rk, persistence stays in c0wrk, and the `go.work` mid-cycle flow (ADR-031) carries the contract between them.

**Negative:**

- The opt-in SDK paths (buckets, pipeline) get no production traffic in c0wrk until a gate passes, so regressions there surface only through sp4rk's own tests/benchmarks.
- Re-evaluating a NO-GO costs a benchmark run on representative hardware; the decision cannot be revisited by configuration alone.

## Alternatives Considered

- **Expose every optimization as a c0wrk config knob** — rejected: knob proliferation on trade-offs users cannot measure; config surface grows with every experiment; defaults still needed a policy.
- **Enable length buckets by default** — rejected: the mixed-corpus case keeps multiple sessions alive and raises peak RSS; short-corpus wins are real but the desktop memory envelope wins.
- **Adopt parallel ONNX sessions (workers=2)** — rejected: +35% docs/s was outweighed by +39% query p95, ~2× RSS, and ~2× CPU on a machine shared with the UI and agent runtime.
- **Dynamic-shape sessions** — rejected during evaluation: 16.8 GiB peak RSS on the mixed corpus from whole-batch output allocation.
