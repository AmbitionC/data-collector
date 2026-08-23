# P0 Content Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Nowcoder candidate carry reliable completeness, company, role, question, first-hand evidence, category, and cross-URL question-cluster metadata before scheduled collection consumes it.

**Architecture:** The extension remains responsible for page-bound extraction and explicit paywall/SSR evidence. The Bridge adds deterministic Nowcoder evidence analysis and question fingerprints before organization and candidate-index commit. No model API or third-party body fixture is added.

**Tech Stack:** TypeScript 7, Chrome Extension MV3, Node.js 22, Vitest 4, JSDOM, Zod.

**Spec:** `docs/superpowers/specs/2026-08-23-scheduled-source-plans-design.md`

## Global Constraints

- Node.js must be `>=22.12`.
- Preserve `CollectedDocument.schemaVersion: 1`; new source fields stay optional and backward compatible.
- Never bypass login, paywall, captcha, or site access controls.
- Do not commit real third-party article bodies; fixtures use minimal anonymized structures.
- The local Markdown library remains the first and mandatory save target.
- Every production behavior is preceded by a failing test and a witnessed RED run.

---

### Task 1: Nowcoder completeness and SSR extraction

**Files:**
- Create: `tests/fixtures/nowcoder-paywalled.html`
- Create: `tests/fixtures/nowcoder-ssr.html`
- Create: `tests/fixtures/nowcoder-page-chrome.html`
- Modify: `tests/unit/extractors.test.ts`
- Modify: `packages/extension/src/extractors/nowcoder.ts`

**Interfaces:**
- Consumes: `buildDocument(BuildDocumentInput): CollectedDocument`.
- Produces: `sourceMetadata.contentAccess` (`full|truncated|paywalled`) and SSR fallback for title, author, published time, and the exact article body.

- [ ] **Step 1: Write failing extractor tests**

```ts
expect(extractDocument(paywalled, URL, NOW).sourceMetadata).toMatchObject({
  contentAccess: 'paywalled',
});
expect(extractDocument(ssrOnly, URL, NOW)).toMatchObject({
  title: '阿里云 Agent 开发一面',
  author: '匿名候选人',
  publishedAt: '2026-08-18T15:39:00.000Z',
});
expect(() => extractDocument(chromeOnly, URL, NOW)).toThrowError(
  expect.objectContaining({ code: 'UNSUPPORTED_LAYOUT' }),
);
```

- [ ] **Step 2: Run the extractor tests and verify RED**

Run: `npm test -- tests/unit/extractors.test.ts`  
Expected: failures because paywall metadata and SSR fallback do not exist, and page chrome is accepted or misclassified.

- [ ] **Step 3: Implement explicit access evidence and narrow SSR fallback**

```ts
type ContentAccess = 'full' | 'truncated' | 'paywalled';

function contentAccessOf(document: Document, content: Element): ContentAccess;
function embeddedNowcoderPost(document: Document, canonicalUrl: URL): {
  title?: string;
  author?: string;
  createdAt?: string;
  contentHtml?: string;
} | undefined;
```

Only parse JSON script objects whose detail ID matches the current URL. Reject candidate bodies dominated by links, controls, creator ranking, recommendations, or purchase UI. Set `truncated: true` for `truncated` and `paywalled` so existing downstream safeguards remain effective.

- [ ] **Step 4: Run extractor tests and verify GREEN**

Run: `npm test -- tests/unit/extractors.test.ts`  
Expected: all extractor tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/extractors/nowcoder.ts tests/unit/extractors.test.ts tests/fixtures/nowcoder-*.html
git commit -m "fix: harden Nowcoder detail extraction"
```

### Task 2: Deterministic company, interview, and authenticity evidence

**Files:**
- Create: `packages/bridge/src/feJourney/nowcoderEvidence.ts`
- Create: `tests/unit/feJourneyNowcoderEvidence.test.ts`
- Modify: `packages/bridge/src/feJourney/index.ts`
- Modify: `packages/bridge/src/feJourney/quality.ts`

**Interfaces:**
- Consumes: a Nowcoder `CollectedDocument` after extension extraction.
- Produces:

```ts
export interface NowcoderEvidence {
  company?: 'bytedance' | 'tencent' | 'alibaba' | 'ant';
  companyLabel?: string;
  businessUnit?: string;
  role?: string;
  interviewRound?: string;
  interviewDate?: string;
  contentAccess: 'full' | 'truncated' | 'paywalled';
  questionCount: number;
  evidenceGrade: 'A' | 'B' | 'C';
  evidenceReasons: string;
}

export function analyzeNowcoderEvidence(document: CollectedDocument): NowcoderEvidence;
export function enrichNowcoderEvidence(document: CollectedDocument): CollectedDocument;
```

- [ ] **Step 1: Write failing evidence tests from anonymized real patterns**

```ts
expect(analyzeNowcoderEvidence(aliOneRound)).toMatchObject({
  company: 'alibaba',
  interviewRound: '一面',
  questionCount: 14,
  evidenceGrade: 'A',
});
expect(scoreFeJourneyCandidate(aliOneRound).candidateKinds).toContain('interview');
expect(analyzeNowcoderEvidence(paywalledRichPost).evidenceGrade).toBe('C');
expect(analyzeNowcoderEvidence(marketingCompilation).evidenceGrade).toBe('C');
```

- [ ] **Step 2: Run evidence tests and verify RED**

Run: `npm test -- tests/unit/feJourneyNowcoderEvidence.test.ts`  
Expected: module/export missing.

- [ ] **Step 3: Implement aliases, question segmentation, and A/B/C grading**

Use literal company alias tables from the spec; require title/role/self-description proximity rather than any company mention. Count numbered items, explicit interviewer questions, question-mark lines, and section questions after normalization. A requires first person, company/role, round/date, at least three questions, `contentAccess=full`, and no promotion; B allows one missing evidence item or one soft project recommendation; all paywalled/truncated/compilation cases are C.

- [ ] **Step 4: Make quality consume evidence without conflating its score**

```ts
const evidence = document.source === 'nowcoder'
  ? analyzeNowcoderEvidence(document)
  : undefined;
if (evidence?.questionCount && evidence.questionCount >= 3) candidateKinds.push('interview');
if (evidence?.evidenceGrade === 'C') exclusionReasons.push('面经证据不足');
```

- [ ] **Step 5: Run evidence and existing quality tests**

Run: `npm test -- tests/unit/feJourneyNowcoderEvidence.test.ts tests/unit/feJourneyQuality.test.ts`  
Expected: both files pass; `qualityScore` remains relevance/completeness while `evidenceGrade` controls consumption eligibility.

- [ ] **Step 6: Commit**

```bash
git add packages/bridge/src/feJourney/nowcoderEvidence.ts packages/bridge/src/feJourney/index.ts packages/bridge/src/feJourney/quality.ts tests/unit/feJourneyNowcoderEvidence.test.ts
git commit -m "feat: grade Nowcoder interview evidence"
```

### Task 3: Source-priority organization and persisted evidence

**Files:**
- Modify: `tests/unit/organize.test.ts`
- Modify: `tests/unit/feJourneyIndex.test.ts`
- Modify: `packages/bridge/src/feJourney/candidateIndex.ts`
- Modify: `packages/bridge/src/organize/classify.ts`

**Interfaces:**
- Consumes: `analyzeNowcoderEvidence` from Task 2.
- Produces: Nowcoder A/B interview candidates with `suggestedCategory: '人工智能'`, source metadata persisted in `source.json`, and no category override from incidental `React` or “设计”.

- [ ] **Step 1: Write failing organization and persistence tests**

```ts
expect(organize(nowcoderAgentWithReactAndDesign).category).toBe('人工智能');
expect(index.prepare(nowcoderAgent).document).toMatchObject({
  suggestedCategory: '人工智能',
  sourceMetadata: { company: 'alibaba', evidenceGrade: 'A', questionCount: 14 },
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/unit/organize.test.ts tests/unit/feJourneyIndex.test.ts`  
Expected: category is `前端开发` or `产品与设计`, and evidence metadata is absent.

- [ ] **Step 3: Enrich before scoring and make source suggestion authoritative below user choice**

```ts
const evidenced = enrichNowcoderEvidence(document);
const candidate = evidenced.source === 'nowcoder' && ['A', 'B'].includes(
  String(evidenced.sourceMetadata?.evidenceGrade),
) ? { ...evidenced, suggestedCategory: '人工智能' } : evidenced;
```

Keep precedence `userCategory > suggestedCategory > generic keyword category`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/unit/organize.test.ts tests/unit/feJourneyIndex.test.ts tests/unit/feJourneyQuality.test.ts`  
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/feJourney/candidateIndex.ts packages/bridge/src/organize/classify.ts tests/unit/organize.test.ts tests/unit/feJourneyIndex.test.ts
git commit -m "fix: prioritize interview source classification"
```

### Task 4: Cross-URL interview question fingerprint

**Files:**
- Modify: `packages/bridge/src/feJourney/fingerprint.ts`
- Modify: `packages/bridge/src/feJourney/candidateIndex.ts`
- Modify: `tests/unit/feJourneyQuality.test.ts`
- Modify: `tests/unit/feJourneyIndex.test.ts`

**Interfaces:**
- Produces:

```ts
export function normalizedInterviewQuestions(text: string): string[];
export function questionFingerprint(text: string): string | undefined;
```

Candidate catalog entries gain optional `questionHash`, `company`, `evidenceGrade`, and `questionCount`; version-1 catalogs without them continue to parse.

- [ ] **Step 1: Write a failing duplicate regression test**

Use an anonymized short 17-question post and a long answer-expanded version with the same questions. Assert equal `questionFingerprint` and `duplicateOf` for the second URL while an unrelated interview remains separate.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/unit/feJourneyQuality.test.ts tests/unit/feJourneyIndex.test.ts`  
Expected: fingerprint export missing and the expanded post starts a separate cluster.

- [ ] **Step 3: Implement question normalization and cluster precedence**

Strip numbering, answer paragraphs, UI, hashtags, promotion tails, punctuation, and generic introductions. Require at least three normalized questions before returning a hash. Match question hash only when company is equal or one side has no company; keep canonical URL and exact body hash stronger than question matching.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/unit/feJourneyQuality.test.ts tests/unit/feJourneyIndex.test.ts`  
Expected: pass and the two representations share one cluster.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/feJourney/fingerprint.ts packages/bridge/src/feJourney/candidateIndex.ts tests/unit/feJourneyQuality.test.ts tests/unit/feJourneyIndex.test.ts
git commit -m "fix: deduplicate interview questions across URLs"
```

### Task 5: Library deletion removes candidate catalog residue

**Files:**
- Modify: `packages/bridge/src/feJourney/candidateIndex.ts`
- Modify: `packages/bridge/src/library/manage.ts`
- Modify: `packages/bridge/src/server/index.ts`
- Modify: `tests/unit/feJourneyIndex.test.ts`
- Modify: `tests/unit/library-manage.test.ts`

**Interfaces:**
- Produces: `FeJourneyCandidateIndex.remove(ids: readonly string[]): Promise<void>`.
- The protected library delete route invokes it only after entries are actually deleted.

- [ ] **Step 1: Write failing deletion tests**

```ts
await index.remove([candidateId]);
expect(JSON.parse(await readFile(catalog, 'utf8')).entries).toEqual([]);
```

Integration assertion: deleting a Nowcoder library entry removes its catalog entry; deleting a normal WeChat/ZSXQ entry is unchanged.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/unit/feJourneyIndex.test.ts tests/unit/library-manage.test.ts`  
Expected: `remove` missing or catalog residue remains.

- [ ] **Step 3: Implement serialized catalog removal and route wiring**

Reuse `commitQueue` and `atomicWriteText`; never edit catalog JSON ad hoc. Return both `deleted` and `missing` counts from the existing API without breaking callers that read only `deleted`.

- [ ] **Step 4: Run P0 tests and full regression**

Run: `npm test -- tests/unit/extractors.test.ts tests/unit/feJourneyNowcoderEvidence.test.ts tests/unit/feJourneyQuality.test.ts tests/unit/feJourneyIndex.test.ts tests/unit/organize.test.ts tests/unit/library-manage.test.ts`  
Then: `npm test && npm run typecheck && npm run build`  
Expected: all pass with no warnings or generated residue outside tracked build artifacts.

- [ ] **Step 5: Commit**

```bash
git add packages/bridge/src/feJourney/candidateIndex.ts packages/bridge/src/library/manage.ts packages/bridge/src/server/index.ts tests/unit/feJourneyIndex.test.ts tests/unit/library-manage.test.ts
git commit -m "fix: remove deleted candidates from the catalog"
```

