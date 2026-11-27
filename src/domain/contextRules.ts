/**
 * Pure domain: Multi-layer Context Rule Evaluator
 * Scores rules across layers:
 *   source -> card -> merchantAlias -> rawKeyword -> amountMin/Max -> currency -> kind -> projectId
 * Respects rule status ('active' | 'shadow' | 'candidate' | 'paused' | 'retired').
 */

export type RuleStatus = 'active' | 'shadow' | 'candidate' | 'paused' | 'retired';

export type ContextLayer =
  | 'source'
  | 'card'
  | 'merchantAlias'
  | 'rawKeyword'
  | 'amountRange'
  | 'currency'
  | 'kind'
  | 'projectId';

export interface ContextInput {
  source?: string;
  card?: string;
  merchantAlias?: string;
  rawText: string;
  amount?: number;
  currency?: string;
  kind?: 'expense' | 'income' | 'transfer';
  travelProjectId?: string;
}

export interface ContextRule {
  id: string;
  name?: string;
  status: RuleStatus;
  priority?: number;

  // Multi-layer match criteria
  source?: string;
  card?: string;
  merchantAlias?: string;
  rawKeyword?: string;
  rawKeywordMatch?: 'contains' | 'equals' | 'regex';
  excludeKeyword?: string;
  amountMin?: number;
  amountMax?: number;
  currency?: string;
  kind?: 'expense' | 'income' | 'transfer' | 'any';
  /** Empty string '' means explicitly daily mode (no travelProjectId). */
  projectId?: string;

  // Target booking output
  categoryId?: string;
  accountId?: string;
  targetProjectId?: string;
  targetCurrency?: string;
  tagIds?: string[];
  noteTemplate?: string;
}

export interface RankedCandidate {
  rule: ContextRule;
  score: number;
  matchedLayers: ContextLayer[];
  reasons: string[];
}

export interface ContextEvalResult {
  primary?: RankedCandidate;
  secondCandidate?: RankedCandidate;
  shadowPredictions: RankedCandidate[];
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
}

const LAYER_WEIGHTS: Record<ContextLayer, number> = {
  projectId: 30,
  card: 25,
  merchantAlias: 25,
  rawKeyword: 20,
  source: 15,
  amountRange: 10,
  currency: 10,
  kind: 10,
};

function norm(s?: string): string {
  return (s ?? '').normalize('NFKC').toLowerCase().trim();
}

function cardMatches(ruleCard: string, inputCard?: string): boolean {
  const rc = norm(ruleCard);
  const ic = norm(inputCard);
  if (!rc || !ic) return false;
  if (rc === ic) return true;
  if (rc.length < 2 || ic.length < 2) return false;
  // Support matching card name or last-4 digits inside "中信LINE Pay卡 (8899)"
  return ic.includes(rc) || rc.includes(ic);
}

function keywordMatches(rule: ContextRule, rawText: string): boolean {
  const kw = rule.rawKeyword?.trim();
  if (!kw) return false;
  const mode = rule.rawKeywordMatch ?? 'contains';
  if (mode === 'regex') {
    try {
      return new RegExp(kw, 'i').test(rawText);
    } catch {
      return false;
    }
  }
  const t = norm(rawText);
  const k = norm(kw);
  if (!k) return false;
  return mode === 'equals' ? t === k : t.includes(k);
}

function evaluateSingleRule(ctx: ContextInput, rule: ContextRule): RankedCandidate | null {
  const matchedLayers: ContextLayer[] = [];
  const reasons: string[] = [];
  let score = 0;

  // Check excludeKeyword first
  if (rule.excludeKeyword?.trim()) {
    const t = norm(ctx.rawText);
    const excludes = rule.excludeKeyword
      .split(/[,，、]/)
      .map((x) => norm(x))
      .filter(Boolean);
    if (excludes.some((ex) => t.includes(ex))) {
      return null;
    }
  }

  // Layer 1: source
  if (rule.source !== undefined && rule.source !== '') {
    if (norm(rule.source) !== norm(ctx.source)) return null;
    matchedLayers.push('source');
    score += LAYER_WEIGHTS.source;
    reasons.push(`source:${rule.source}`);
  }

  // Layer 2: card
  if (rule.card !== undefined && rule.card !== '') {
    if (!cardMatches(rule.card, ctx.card)) return null;
    matchedLayers.push('card');
    score += LAYER_WEIGHTS.card;
    reasons.push(`card:${rule.card}`);
  }

  // Layer 3: merchantAlias
  if (rule.merchantAlias !== undefined && rule.merchantAlias !== '') {
    if (norm(rule.merchantAlias) !== norm(ctx.merchantAlias)) return null;
    matchedLayers.push('merchantAlias');
    score += LAYER_WEIGHTS.merchantAlias;
    reasons.push(`merchantAlias:${rule.merchantAlias}`);
  }

  // Layer 4: rawKeyword
  if (rule.rawKeyword !== undefined && rule.rawKeyword !== '') {
    if (!keywordMatches(rule, ctx.rawText)) return null;
    matchedLayers.push('rawKeyword');
    score += LAYER_WEIGHTS.rawKeyword;
    reasons.push(`rawKeyword:${rule.rawKeyword}`);
  }

  // Layer 5: amountMin / amountMax
  if (rule.amountMin !== undefined || rule.amountMax !== undefined) {
    if (ctx.amount === undefined) return null;
    if (rule.amountMin !== undefined && ctx.amount < rule.amountMin) return null;
    if (rule.amountMax !== undefined && ctx.amount > rule.amountMax) return null;
    matchedLayers.push('amountRange');
    score += LAYER_WEIGHTS.amountRange;
    reasons.push(`amountRange:[${rule.amountMin ?? '-inf'},${rule.amountMax ?? '+inf'}]`);
  }

  // Layer 6: currency
  if (rule.currency !== undefined && rule.currency !== '') {
    if (norm(rule.currency) !== norm(ctx.currency)) return null;
    matchedLayers.push('currency');
    score += LAYER_WEIGHTS.currency;
    reasons.push(`currency:${rule.currency}`);
  }

  // Layer 7: kind
  if (rule.kind !== undefined && rule.kind !== 'any') {
    if (ctx.kind !== rule.kind) return null;
    matchedLayers.push('kind');
    score += LAYER_WEIGHTS.kind;
    reasons.push(`kind:${rule.kind}`);
  }

  // Layer 8: projectId (travelProjectId vs daily mode)
  if (rule.projectId !== undefined) {
    if (rule.projectId === '') {
      if (ctx.travelProjectId) return null;
      matchedLayers.push('projectId');
      score += LAYER_WEIGHTS.projectId;
      reasons.push('projectId:daily');
    } else {
      if (ctx.travelProjectId !== rule.projectId) return null;
      matchedLayers.push('projectId');
      score += LAYER_WEIGHTS.projectId;
      reasons.push(`projectId:${rule.projectId}`);
    }
  }

  // Must match at least one substantive layer
  const hasSubstantive = matchedLayers.some(
    (l) =>
      l === 'source' ||
      l === 'card' ||
      l === 'merchantAlias' ||
      l === 'rawKeyword' ||
      l === 'projectId',
  );
  if (!hasSubstantive) return null;

  return {
    rule,
    score,
    matchedLayers,
    reasons,
  };
}

function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.matchedLayers.length !== a.matchedLayers.length) {
    return b.matchedLayers.length - a.matchedLayers.length;
  }
  const pa = a.rule.priority ?? 100;
  const pb = b.rule.priority ?? 100;
  if (pa !== pb) return pa - pb;
  const lenA = (a.rule.rawKeyword?.length ?? 0) + (a.rule.merchantAlias?.length ?? 0);
  const lenB = (b.rule.rawKeyword?.length ?? 0) + (b.rule.merchantAlias?.length ?? 0);
  return lenB - lenA;
}

/**
 * Evaluates a context input against multi-layer rules.
 * - 'paused' and 'retired' rules are skipped.
 * - 'shadow' and 'candidate' rules are returned in shadowPredictions only.
 * - 'active' rules compete for primary and secondCandidate.
 */
export function evaluateContextRules(
  ctxInput: ContextInput,
  rules: ContextRule[],
): ContextEvalResult {
  const activeCandidates: RankedCandidate[] = [];
  const shadowPredictions: RankedCandidate[] = [];

  for (const rule of rules) {
    if (rule.status === 'paused' || rule.status === 'retired') {
      continue;
    }
    const candidate = evaluateSingleRule(ctxInput, rule);
    if (!candidate) continue;

    if (rule.status === 'shadow' || rule.status === 'candidate') {
      shadowPredictions.push(candidate);
    } else if (rule.status === 'active') {
      activeCandidates.push(candidate);
    }
  }

  activeCandidates.sort(compareCandidates);
  shadowPredictions.sort(compareCandidates);

  const primary = activeCandidates[0];
  const secondCandidate = activeCandidates[1];

  if (!primary) {
    return {
      shadowPredictions,
      confidence: 'low',
      reasons: shadowPredictions.length > 0 ? ['only_shadow_or_candidate_matched'] : ['no_rule_matched'],
    };
  }

  const reasons = [...primary.reasons];
  const sameTargetAsSecond =
    secondCandidate &&
    secondCandidate.rule.categoryId === primary.rule.categoryId &&
    secondCandidate.rule.accountId === primary.rule.accountId;

  const isExactTieDifferentTarget =
    secondCandidate &&
    secondCandidate.score === primary.score &&
    !sameTargetAsSecond;

  const isCloseRunnerUpDifferentTarget =
    secondCandidate &&
    !sameTargetAsSecond &&
    primary.score - secondCandidate.score < 10;

  let confidence: 'high' | 'medium' | 'low';
  if (isExactTieDifferentTarget) {
    confidence = 'low';
    reasons.push('tie_with_different_target');
  } else if (isCloseRunnerUpDifferentTarget) {
    confidence = 'medium';
    reasons.push('close_runner_up_different_target');
  } else if (
    primary.score >= 45 ||
    (primary.matchedLayers.length >= 2 && (!secondCandidate || primary.score - secondCandidate.score >= 15))
  ) {
    confidence = 'high';
  } else if (primary.score >= 25) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    primary,
    secondCandidate,
    shadowPredictions,
    confidence,
    reasons,
  };
}
