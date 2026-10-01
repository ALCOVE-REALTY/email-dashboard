// Mock AI provider - real keyword/pattern matching (not random or
// hard-coded example numbers), calling tools.js's real functions for
// every data-backed reply. This is the ONLY piece a real Claude provider
// replaces later (see provider.js) - it stands in for the "decide which
// tool to call from natural language" step an LLM would otherwise do;
// the tools themselves, and the UI that renders their result, don't
// change when that swap happens.
const tools = require('./tools');

// { pattern, handler } - checked in order, first match wins. Patterns are
// plain keyword tests, not full NLU, but cover every example command the
// spec itself lists plus their obvious paraphrases.
const RULES = [
  {
    test: (m) => /department[- ]?wise|each department|by department/.test(m) && /headcount|active employees|how many/.test(m),
    run: () => tools.departmentHeadcount(),
    intro: "Sure. Here's the department-wise active headcount report."
  },
  {
    test: (m) => /joining trend|join.*trend|trend.*joining/.test(m),
    run: () => tools.joiningTrend(),
    intro: "Here's the joining trend for the last 12 months."
  },
  {
    test: (m) => /(join|joined|joining).*(this month|month)/.test(m),
    run: () => tools.joiningThisMonth(),
    intro: 'Here are the employees joining this month.'
  },
  {
    test: (m) => /confirmation.*(due|pending)/.test(m) && /next month/.test(m),
    run: () => tools.pendingConfirmations(1),
    intro: "Here's who has a confirmation due next month."
  },
  {
    test: (m) => /confirmation.*(due|pending)/.test(m),
    run: () => tools.pendingConfirmations(0),
    intro: "Here's who has a confirmation due this month."
  },
  {
    test: (m) => /workforce movement|movement.*(last|past)/.test(m),
    run: (m) => {
      const monthsMatch = m.match(/last (\d+) months?/);
      const days = monthsMatch ? parseInt(monthsMatch[1], 10) * 30 : 90;
      return tools.workforceMovement(days);
    },
    intro: (m) => {
      const monthsMatch = m.match(/last (\d+) months?/);
      const months = monthsMatch ? monthsMatch[1] : '3';
      return "Here's the workforce movement summary for the last " + months + ' months.';
    }
  },
  {
    test: (m) => /retire|retirement/.test(m),
    run: () => tools.retirementThisMonth(),
    intro: 'Here are the employees who will reach retirement age this month.'
  },
  {
    test: (m) => /health insurance/.test(m) && /pending|addition/.test(m),
    run: () => tools.healthInsurancePendingAdditions(),
    intro: 'Here are the pending health insurance additions.'
  },
  {
    test: (m) => /organi[sz]ation chart|org chart/.test(m),
    run: () => tools.navigateToView('orgChart'),
    intro: 'You can view the organization chart here.'
  },
  {
    test: (m) => /data quality/.test(m),
    run: () => tools.dataQualityIssues(),
    intro: 'Here are the current data quality issues.'
  },
  {
    test: (m) => /insight/.test(m),
    run: () => tools.insightsSummary(),
    intro: 'Here are some insights from the current workforce data.'
  },
  {
    test: (m) => /age distribution|by age/.test(m),
    run: () => tools.demographics('age'),
    intro: "Here's the age distribution."
  },
  {
    test: (m) => /gender distribution|by gender/.test(m),
    run: () => tools.demographics('gender'),
    intro: "Here's the gender distribution."
  },
  {
    test: (m) => /collar|category distribution/.test(m),
    run: () => tools.demographics('collar'),
    intro: "Here's the category distribution."
  },
  {
    test: (m) => /(promotion|increment|confirmation) letter/.test(m) && /(for|to)\s+\w/.test(m),
    run: async (m) => {
      const nameMatch = m.match(/(?:for|to)\s+([a-z][a-z .]*)$/i);
      const name = nameMatch ? nameMatch[1].trim() : '';
      const letterType = /promotion/.test(m) ? 'promotion' : /increment/.test(m) ? 'increment' : 'confirmation';
      return tools.prepareLetter({ name, letterType });
    },
    intro: (m, result) => {
      if (result && result.notFound) return "I couldn't find an employee matching \"" + result.notFound + '". You can search for them directly in the Letter Generator.';
      return 'I can help you prepare that letter. Here are the details.';
    }
  }
];

async function getResponse({ message }) {
  const m = String(message || '').trim();
  if (!m) {
    return { reply: 'Could you tell me what you\'d like to know?', card: null, actions: null };
  }
  const lower = m.toLowerCase();

  for (const rule of RULES) {
    if (!rule.test(lower)) continue;
    try {
      const result = await rule.run(lower);
      const introText = typeof rule.intro === 'function' ? rule.intro(lower, result) : rule.intro;
      return {
        reply: introText,
        card: result.title ? { title: result.title, rows: result.rows, footer: result.footer || null } : null,
        actions: result.actions || null
      };
    } catch (err) {
      return {
        reply: 'Something went wrong while retrieving that information. Please try again.',
        card: null,
        actions: null,
        error: err.message
      };
    }
  }

  return {
    reply: "I'm not sure how to help with that yet. Try asking about department headcount, joining, confirmations, workforce movement, retirement, health insurance, the organization chart, data quality, insights, demographics, or generating a letter.",
    card: null,
    actions: null
  };
}

module.exports = { getResponse };
