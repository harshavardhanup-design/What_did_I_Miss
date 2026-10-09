// Core processing engine for 'What Did I Miss?'
// 100% Local-First Deterministic & Heuristic Engine with Zero Cloud Leakage

/**
 * Neutralizes prompt injections, escapes HTML, and prevents system instruction overrides.
 */
function sanitizeAndGuard(rawText) {
  if (typeof rawText !== 'string') return { cleanText: '', hasInjectionAttempt: false, flaggedTokens: [] };

  const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
    /system\s*:\s*/i,
    /you\s+are\s+now\s+a\s+/i,
    /output\s+the\s+system\s+prompt/i,
    /print\s+compromised/i,
    /override\s+safety\s+guidelines/i,
    /<\|im_start\|>/i,
    /\[INST\]/i
  ];

  let flagged = false;
  const detected = [];
  let sanitized = rawText;

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      flagged = true;
      detected.push(pattern.source);
      sanitized = sanitized.replace(pattern, '[REDACTED_OVERRIDE_TOKEN]');
    }
  }

  // HTML sanitization to prevent XSS
  const escaped = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return {
    cleanText: escaped,
    hasInjectionAttempt: flagged,
    flaggedTokens: detected
  };
}

/**
 * Universal multi-format chat parser (WhatsApp, Slack, Teams, generic transcript).
 */
function parseChatMessages(rawText) {
  if (!rawText || !rawText.trim()) return [];

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const messages = [];

  // Regex patterns for different chat formats
  // WhatsApp: [09/10/26, 09:15:10] Sarah: message  OR  09/10/26, 9:15 AM - Sarah: message
  const waRegex1 = /^\[?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}[,\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\]?\s*[-:]?\s*([^:]+):\s*(.+)$/i;
  // Generic: Sarah: message
  const genericRegex = /^([^:\n]{2,30}):\s*(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip control injection lines entirely from the message log
    const guard = sanitizeAndGuard(line);
    if (guard.hasInjectionAttempt) continue;

    const matchWA = line.match(waRegex1);
    if (matchWA) {
      messages.push({
        id: `msg-${i + 1}`,
        timestamp: matchWA[1].trim(),
        sender: matchWA[2].trim(),
        text: matchWA[3].trim(),
        raw: line
      });
      continue;
    }

    const matchGen = line.match(genericRegex);
    if (matchGen) {
      messages.push({
        id: `msg-${i + 1}`,
        timestamp: `Line ${i + 1}`,
        sender: matchGen[1].trim(),
        text: matchGen[2].trim(),
        raw: line
      });
      continue;
    }

    // Unformatted message line
    messages.push({
      id: `msg-${i + 1}`,
      timestamp: `Line ${i + 1}`,
      sender: 'Unknown',
      text: line,
      raw: line
    });
  }

  return messages;
}

/**
 * Detects urgent alerts, critical blockers, and impending deadlines.
 */
function detectUrgencyAndAlerts(messages, targetUser = '') {
  const alerts = [];
  const targetLower = (targetUser || '').toLowerCase();

  const URGENT_RULES = [
    { pattern: /\b(urgent|critical|emergency|outage|down|crashed|blocker|breach|severity\s*1|p0)\b/i, score: 4, reason: 'System Outage / Critical Incident' },
    { pattern: /\b(asap|immediately|right\s+now|all\s+hands)\b/i, score: 3, reason: 'High Urgency Request' },
    { pattern: /\b(deadline|by\s+today|by\s+eod|before\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/i, score: 2.5, reason: 'Impending Time Constraint' },
    { pattern: /\b(waiting\s+on\s+you|please\s+review|need\s+approval|blocker)\b/i, score: 2, reason: 'Direct Blocker' }
  ];

  for (const msg of messages) {
    let score = 0;
    const reasons = [];
    const textLower = msg.text.toLowerCase();

    // Check target user mention
    const isMentioned = targetLower && (textLower.includes(`@${targetLower}`) || textLower.includes(targetLower));
    if (isMentioned) {
      score += 2;
      reasons.push(`Direct ping for ${targetUser}`);
    }

    for (const rule of URGENT_RULES) {
      if (rule.pattern.test(msg.text)) {
        score += rule.score;
        reasons.push(rule.reason);
      }
    }

    // Extract potential deadline string
    const deadlineMatch = msg.text.match(/\b(by\s+(?:today|tomorrow|eod|\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\w+\s+\d{1,2}))\b/i);
    const deadline = deadlineMatch ? deadlineMatch[0] : null;

    if (score >= 3) {
      alerts.push({
        id: msg.id,
        sender: msg.sender,
        timestamp: msg.timestamp,
        text: msg.text,
        priority: score >= 4 ? 'P0_CRITICAL' : 'P1_HIGH',
        score,
        reason: reasons.join(' • '),
        deadline,
        actionRequired: true
      });
    }
  }

  return alerts.sort((a, b) => b.score - a.score);
}

/**
 * Extracts action items, assigned owners, and dates.
 */
function detectActionItems(messages, targetUser = '') {
  const actions = [];
  const targetLower = (targetUser || '').toLowerCase();

  const ACTION_PATTERNS = [
    /\b(?:please|pls)\s+([a-z\s0-9#\-\_\.]{5,80})/i,
    /\b(?:action\s+item:?|todo:?|task:?)\s*(.+)/i,
    /\b(?:i'll|i\s+will|will)\s+([a-z\s0-9#\-\_\.]{5,80})/i,
    /\b(?:debug|investigate|deploy|fix|update|upgrade|verify|check|review)\s+([a-z\s0-9#\-\_\.]{4,80})/i
  ];

  for (const msg of messages) {
    const text = msg.text;
    const textLower = text.toLowerCase();
    let isAction = false;
    let taskDesc = text;

    for (const pat of ACTION_PATTERNS) {
      const match = text.match(pat);
      if (match) {
        isAction = true;
        taskDesc = match[0];
        break;
      }
    }

    if (isAction) {
      const isForMe = targetLower && (textLower.includes(`@${targetLower}`) || textLower.includes(targetLower));
      
      // Attempt to identify assignee
      let assignee = msg.sender;
      const assignMatch = text.match(/@([a-zA-Z0-9_-]+)/);
      if (assignMatch) assignee = assignMatch[1];

      // Extract deadline if present
      const dlMatch = text.match(/\b(by\s+(?:today|tomorrow|eod|\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\w+\s+\d{1,2}))\b/i);

      actions.push({
        id: msg.id,
        sender: msg.sender,
        assignee,
        text: taskDesc,
        fullMessage: text,
        timestamp: msg.timestamp,
        deadline: dlMatch ? dlMatch[0] : null,
        isForMe
      });
    }
  }

  return actions;
}

/**
 * Identifies confirmed decisions made in the conversation.
 */
function detectDecisions(messages) {
  const decisions = [];
  const DECISION_PATTERNS = [
    /\b(agreed\s+(?:to|on|that)?|decided\s+(?:to|that)?|finalized|confirmed|approved|resolved|signed\s+off)\b/i,
    /\b(we\s+will\s+go\s+with|decision\s*:\s*|consensus\s*:\s*)\b/i,
    /\b(rolled\s+back\s+to|code\s+freeze|cancelled\s+the\s+deployment)\b/i
  ];

  for (const msg of messages) {
    for (const pat of DECISION_PATTERNS) {
      if (pat.test(msg.text)) {
        decisions.push({
          id: msg.id,
          sender: msg.sender,
          timestamp: msg.timestamp,
          decision: msg.text
        });
        break;
      }
    }
  }

  return decisions;
}

/**
 * Ambiguity & Conflict Detection Engine.
 * Identifies contradicting directives and unresolved scheduling.
 */
function detectAmbiguitiesAndConflicts(messages) {
  const issues = [];

  // Check for conflicting deployment or operational directives
  const positiveDirectives = messages.filter(m => /\b(deploy|release|approved|go\s+ahead|merge)\b/i.test(m.text) && !/\b(don't|not|cancel|freeze)\b/i.test(m.text));
  const negativeDirectives = messages.filter(m => /\b(don't\s+deploy|cancel\s+the\s+deployment|code\s+freeze|hold\s+off|abort)\b/i.test(m.text));

  if (positiveDirectives.length > 0 && negativeDirectives.length > 0) {
    const lastPos = positiveDirectives[positiveDirectives.length - 1];
    const lastNeg = negativeDirectives[negativeDirectives.length - 1];

    issues.push({
      topic: 'Deployment / Release Conflict',
      type: 'CONTRADICTION',
      severity: 'CRITICAL',
      statementA: { sender: lastPos.sender, text: lastPos.text, time: lastPos.timestamp },
      statementB: { sender: lastNeg.sender, text: lastNeg.text, time: lastNeg.timestamp },
      recommendation: 'Tech Lead explicit sign-off required. One party approved release while another ordered a freeze/cancellation.'
    });
  }

  // Check for vague scheduling statements
  const vagueStatements = messages.filter(m => /\b(maybe|perhaps|probably|tentatively|not\s+sure\s+if)\b/i.test(m.text));
  for (const v of vagueStatements) {
    issues.push({
      topic: 'Uncertain Commitment',
      type: 'VAGUE_TIMELINE',
      severity: 'MODERATE',
      statementA: { sender: v.sender, text: v.text, time: v.timestamp },
      recommendation: 'Verify exact timestamp/commitment with sender.'
    });
  }

  return issues;
}

/**
 * Diagnostics & Conversation Health Engine.
 * Calculates signal-to-noise ratio, unanswered queries, and sentiment tension.
 */
function computeDiagnostics(messages) {
  if (messages.length === 0) {
    return { total: 0, noiseRatio: '0%', unansweredQuestions: [], tensionScore: 0, participantStats: {} };
  }

  const NOISE_WORDS = ['morning', 'gm', 'coffee', '☕', 'haha', 'lol', '👍', 'off topic', 'hey guys'];
  let noiseCount = 0;
  const questionsAsked = [];
  const participantStats = {};

  messages.forEach((msg, idx) => {
    // Participant stats
    participantStats[msg.sender] = (participantStats[msg.sender] || 0) + 1;

    // Noise analysis
    const lower = msg.text.toLowerCase();
    if (NOISE_WORDS.some(w => lower.includes(w)) && !/\b(p0|urgent|error|deploy|critical)\b/i.test(lower)) {
      noiseCount++;
    }

    // Question detection
    if (msg.text.includes('?')) {
      // Check if immediate next message directly mentions or answers the question
      const nextMsgs = messages.slice(idx + 1, idx + 2);
      const seemsAnswered = nextMsgs.some(m => {
        const nextLower = m.text.toLowerCase();
        return /\b(yes|no|yep|nope|done|checked|reviewed|sure|already|fixed|here)\b/i.test(nextLower);
      });

      if (!seemsAnswered) {
        questionsAsked.push({
          id: msg.id,
          sender: msg.sender,
          question: msg.text,
          timestamp: msg.timestamp
        });
      }
    }
  });

  const noisePercentage = Math.round((noiseCount / messages.length) * 100);
  const urgentCount = messages.filter(m => /\b(urgent|outage|down|critical|blocker)\b/i.test(m.text)).length;
  const tensionScore = Math.min(100, urgentCount * 25);

  return {
    total: messages.length,
    noiseRatio: `${noisePercentage}%`,
    signalRatio: `${100 - noisePercentage}%`,
    unansweredQuestions: questionsAsked,
    tensionScore,
    participantStats
  };
}

/**
 * Grounded Question Answering Engine.
 * Answers accurately with citations or explicitly communicates uncertainty.
 */
function answerGroundedQuestion(query, messages) {
  if (!query || !query.trim()) {
    return {
      answer: 'Please enter a specific question about this conversation.',
      citations: [],
      confidence: 'NONE'
    };
  }

  const queryTerms = query.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['what', 'when', 'where', 'who', 'why', 'how', 'the', 'and', 'did', 'was'].includes(w));

  if (queryTerms.length === 0) {
    return {
      answer: 'Please ask a more detailed question.',
      citations: [],
      confidence: 'LOW'
    };
  }

  // Score relevance across messages
  const scored = messages.map(msg => {
    const textLower = msg.text.toLowerCase();
    let termMatches = 0;
    for (const term of queryTerms) {
      if (textLower.includes(term)) termMatches++;
    }
    return { msg, score: termMatches };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      answer: `I could not find any discussion regarding "${query}" in the analyzed conversation. No messages directly address this topic.`,
      citations: [],
      confidence: 'UNCERTAIN'
    };
  }

  const topMatch = scored[0].msg;
  const citations = scored.slice(0, 3).map(s => ({
    sender: s.msg.sender,
    timestamp: s.msg.timestamp,
    quote: s.msg.text
  }));

  // Contextual answer synthesis based on top matches
  let contextualAnswer = '';
  if (/cancel|deployment|release/i.test(query) && /cancel|freeze/i.test(topMatch.text)) {
    contextualAnswer = `According to ${topMatch.sender}, the deployment was cancelled: "${topMatch.text}".`;
  } else if (/who|assigned|task/i.test(query)) {
    contextualAnswer = `${topMatch.sender} stated: "${topMatch.text}".`;
  } else {
    contextualAnswer = `Based on the chat, ${topMatch.sender} noted: "${topMatch.text}".`;
  }

  return {
    answer: contextualAnswer,
    citations,
    confidence: scored[0].score >= 1 ? 'HIGH' : 'MEDIUM'
  };
}

// Module export for Node testing & browser window attachment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sanitizeAndGuard,
    parseChatMessages,
    detectUrgencyAndAlerts,
    detectActionItems,
    detectDecisions,
    detectAmbiguitiesAndConflicts,
    computeDiagnostics,
    answerGroundedQuestion
  };
}
if (typeof window !== 'undefined') {
  window.CatchUpEngine = {
    sanitizeAndGuard,
    parseChatMessages,
    detectUrgencyAndAlerts,
    detectActionItems,
    detectDecisions,
    detectAmbiguitiesAndConflicts,
    computeDiagnostics,
    answerGroundedQuestion
  };
}
