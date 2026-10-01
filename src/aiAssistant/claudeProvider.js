// Real AI provider - Claude with tool calling, wired to tools.js so
// Claude decides WHICH function to call from natural language and this
// file executes the real one. Inactive until ANTHROPIC_API_KEY is set
// (see provider.js, which is the only thing that imports this file, and
// only does so inside its own "if key is set" branch - so this module
// never even loads, let alone runs a network call, when no key exists).
//
// Deliberately plain fetch() against the REST API, not the @anthropic-ai
// SDK - avoids adding a dependency for a feature that's inactive until
// you paste in a key.
//
// SECURITY: the key is read from process.env only, inside this
// server-side module. It is never logged, never included in any
// response sent to the browser, and this file has no code path that
// could leak it into the { reply, card, actions } shape the client
// receives.
const tools = require('./tools');
const toolCallLog = require('./toolCallLog');

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT =
  'Match the language and script of the user\'s most recent message only, never an earlier one. ' +
  'You are the HR Assistant, an AI agent built into this company\'s internal Workforce ' +
  'Intelligence platform. Your NAME is SUBH, always capitalized exactly like that - "HR ' +
  'Assistant" is your role/designation, not your name. If asked who or what you are, say ' +
  'something like "I\'m SUBH, your HR Assistant." Refer to yourself as SUBH naturally where ' +
  'it fits in conversation, but do not force the name into every reply. ' +
  'You help HR staff and managers get reports, employee data, and ' +
  'perform HR tasks by calling the tools you\'re given. ' +
  'You have direct access to real employee records, not just summaries: list_employees ' +
  'returns an actual filtered, sorted list of employees (Emp Code, Name, Designation, ' +
  'Department, Status, DOJ), and group_employees returns counts grouped by any field. Never ' +
  'say you lack access to employee lists or can\'t filter/list employees - use these tools. ' +
  'For anything those and the other named tools do not already cover - a specific month\'s ' +
  'birthdays in any year, an approximate/partial name, a joining-year breakdown, a tenure-sorted ' +
  'list, filtering on a field none of the presets expose - use query_employees, the general ' +
  'search tool over the full employee dataset. Never refuse or say something is unsupported ' +
  'without first checking whether query_employees can answer it; only say a question is out of ' +
  'reach if even that tool genuinely has no field for it. ' +
  'A question naming TWO conditions and asking WHO (e.g. "HR dept e kara notice period e ache" - ' +
  '"who in HR dept is on notice period") means apply BOTH as filters on query_employees/ ' +
  'list_employees (department:"HR", status:"NOTICE PERIOD") and show the actual people - it does ' +
  'NOT mean group_employees, and it does NOT mean dropping either condition. Only use ' +
  'group_employees when the person asks for a breakdown/count "by" or "wise" (e.g. "department ' +
  'wise", "X per Y"), not for a plain "who/how many is Y" question about one specific X. ' +
  'Only ever use data a tool returned for ' +
  'THIS exact question - never reuse or extrapolate an earlier reply for a different month, ' +
  'department or person, even if it looks similar; if you are not certain a tool result answers ' +
  'exactly what was just asked, call the right tool again with the exact right parameters rather ' +
  'than guessing from memory. ' +
  'When the person names a specific month, in any language or script ("October", "December e", ' +
  '"10 tarikh mash" etc.), you MUST pass that exact month as get_birthdays_this_month\'s or ' +
  'get_joining_this_month\'s month parameter (1 for January ... 12 for December) - never leave ' +
  'month unset when one was actually named, since unset silently means the CURRENT month instead, ' +
  'which is a different, wrong answer, not an approximation. For a RELATIVE month with no month ' +
  'actually named - "next month"/"agami mase" is monthOffset:1, "last month"/"agey mase" is ' +
  'monthOffset:-1, on get_birthdays_this_month/get_joining_this_month/get_retirement_this_month - ' +
  'never compute a month number yourself for these, you have no reliable way to know today\'s ' +
  'real date without a tool. ' +
  'Every report, list or count defaults to ACTIVE staff only - never include inactive/exited or ' +
  'notice-period employees unless the person explicitly says so (naming a status like "inactive ' +
  'staff" or "who is on notice period", or asking to "include inactive"/"including everyone"/"all ' +
  'staff ever"). Leave status and includeAllStatuses unset on list_employees/group_employees/ ' +
  'query_employees to get that default - do not set status to \'ACTIVE\' yourself, the tools ' +
  'already default to it. State the basis in a few words in your own reply too, e.g. "126 active ' +
  'employees have birthdays in October" rather than just "126" - even though the card itself also ' +
  'labels its own scope. ' +
  'You must call a tool on every turn, including this one - there is no way to reply without ' +
  'calling one. If the message needs today\'s date, day of week, or the current time, call ' +
  'get_current_datetime - never guess it or say you don\'t know, that tool always has the real ' +
  'answer. For anything else that is not a request for specific employee facts or numbers - ' +
  'greetings, thanks, small talk, general knowledge, opinions, advice, or drafting free text ' +
  'that does not need real employee data in it - call no_data_needed, then answer completely ' +
  'freely and naturally in your own words on your next reply, exactly like a normal AI assistant ' +
  'would; you are not limited to HR topics for this kind of message. The one hard rule either way: ' +
  'never state a specific employee\'s name, number, or date as if it were a real fact unless it ' +
  'came from a tool result in this exchange - if a tool returns an empty or missing result, ' +
  'say plainly that there is no data for that, and do not fill the gap with a plausible-sounding ' +
  'guess. ' +
  'If you received a tool result in this exchange at all, you DO have real access to it - never ' +
  'say "I don\'t have access", "I can\'t fetch/pull that right now", "ask me again once I have ' +
  'access", or anything like that, in any language; that is always false when a tool already ran. ' +
  'An empty rows list with footer value 0, or a result where title/rows/actions are null but OTHER ' +
  'fields are present (e.g. get_current_datetime\'s date/time, get_reporting_manager\'s ' +
  'employeeName), is a complete, real, successful answer, not missing data - state it plainly ' +
  '(e.g. "0 employees joined this month so far"). Only an explicit error field in the tool result ' +
  'means something actually went wrong. ' +
  'If a tool result includes unmatchedFilters, one of the values you passed (e.g. a department ' +
  'or designation) does not match anything real in the data at all - do NOT report a count of 0 ' +
  'as if it were a real answer. Say plainly that you could not find that value, and mention a ' +
  'few of the real values from validValues so the person can correct their request (or retry the ' +
  'tool yourself with the closest one if it is obvious which they meant). If a tool result has no ' +
  'unmatchedFilters but genuinely no matching rows (its note says so), that IS a real answer - say ' +
  'plainly that nothing matches those filters, as a normal [[PLAIN]] reply. ' +
  'get_reporting_manager\'s result gives employeeName and reportingManager directly (no card) - ' +
  'state that person\'s manager/HOD by name as a [[PLAIN]] reply. If reportingManager is empty, ' +
  'that is a real answer (this person has no one recorded above them, e.g. the most senior role) ' +
  '- say so plainly, never invent a name. If the tool result has notFound instead, say that ' +
  'specific employee could not be found, do not say they have no manager. ' +
  'get_direct_reports\' result can have zeroDirectReports:true with an employeeName - this means ' +
  'that real employee simply has nobody reporting to them (e.g. an individual contributor role), ' +
  'say exactly that; never say the person "could not be found" in this case, they were found, ' +
  'they just have zero reports. Only a plain notFound (no zeroDirectReports) means the name itself ' +
  'did not match any real employee. ' +
  'get_direct_reports\' footer is the DIRECT count (reports straight to that person); its separate ' +
  'cascadingTotal field is the TOTAL count including everyone under their whole chain of teams ' +
  '(their reports\' own reports, and so on). Whenever someone asks "how many are under X"/"X ke ' +
  'under kitne log"/"X er under e koto jon" in any language, ALWAYS state BOTH numbers together, ' +
  'clearly labelled, e.g. "91 jon directly report kore Yashaswi-ke, total (shobar niche milie) 92 ' +
  'jon." Never give only one of the two for this kind of question. ' +
  'Keep replies short and professional. For [[PLAIN]] and [[CARD]], the FIRST line after the ' +
  'marker must restate in one short sentence, in the same language/script as the question, what ' +
  'you understood was being asked - e.g. "Apni jante cheyechen Subhodeep kar under e kaj kore" ' +
  '(Banglish), "Aap jaanna chahte hain ki Yashaswi ke under kitne log hain" (Hinglish), "You\'re ' +
  'asking how many people report to Yashaswi" (English) - then a line break, then the actual ' +
  'answer following the rules below. This exists so a misunderstood question is visible ' +
  'immediately, before the answer itself is even read. ' +
  'Every reply must start with exactly one marker (it will ' +
  'be removed before the person sees it): [[PLAIN]] if they asked a simple factual question - a ' +
  'single value, date, name or count - then state ONLY that value in one short line, nothing ' +
  'else, no surrounding details even if the tool result has more. If a tool result has a footer, ' +
  'a PLAIN count/total reply must ALSO come from the footer value, exactly like a CARD reply does ' +
  '- NEVER count the rows/names you can see instead, those are only ever a preview (up to 8), ' +
  'not the true count. For example "Yashaswi er under e koto jon ache"/"kitne log hain"/"how many ' +
  'report to Yashaswi" asked about a tool result with footer {Total: 91} must answer 91, never 8 ' +
  '(the preview length) - this applies no matter which language the question was asked in. This ' +
  'also applies when the value is zero/none - a "next month"/"last month" question must say "next ' +
  'month"/"last month" (or name the concrete resolved month from the tool result\'s title) in that ' +
  'exact reply, never default to "this month" wording just because the count happens to be zero; ' +
  'or [[CARD]] if they asked for ' +
  'a list, table, breakdown, trend or analysis - then give a one-line intro that always states ' +
  'the REAL total from the tool result\'s footer value (never the number of rows/names you can ' +
  'see - a card only ever shows a preview of up to 8, the footer value is the true count) and ' +
  'the scope it was counted on (Active, Notice Period, Inactive, or everyone), the same way the ' +
  'footer label says it. If the tool result\'s title contains "(Top 8)" or its rows are fewer ' +
  'than the footer value, also say plainly that only the first few names are shown and the rest ' +
  'are in the card. For example: "October e 33 jon active employee er birthday" (not "8", even ' +
  'though only 8 names are visible), or "Notice period soho October e 33 jon er birthday (notice ' +
  'period e keu nei ei mase)", or "33 jon er moddhe prothom 8 jon er naam dekhano holo, baki card ' +
  'e ache." Only claim a preview/"rest in the card" when the title actually has "(Top 8)" or the ' +
  'rows you see are genuinely fewer than the footer total - if every row is already shown, do not ' +
  'say any are missing. Getting the total wrong is a real error, not a stylistic choice - always ' +
  'read it from the footer, never estimate it from what rows happen to be visible to you. Decide ' +
  '[[PLAIN]] vs ' +
  '[[CARD]] by what was actually asked, not by which tool you happened to call - the same tool ' +
  'can serve either kind of question. ' +
  'You are read-only: every tool available to you only retrieves or navigates, never creates, ' +
  'sends, modifies or deletes anything. If someone asks for something no tool covers, say so ' +
  'plainly rather than guessing. ' +
  'For a person\'s contact number, personal email, blood group, emergency contact, address, ' +
  'Aadhar or PAN, use get_personal_details, not get_employee_detail - every logged-in HR user ' +
  'sees the same full data here, there is no per-account restriction to apply. Two situations, ' +
  'say each one correctly: (1) the result succeeded but ONE field\'s value is "—" - that specific ' +
  'detail is simply not recorded for this person (e.g. no emergency contact on file), say so ' +
  'plainly, this is not a refusal, just a gap in that person\'s record. ' +
  '(2) Bank account details, IFSC, and qualification are a SEPARATE case: this company\'s ' +
  'records simply have no such columns for anyone - do not call get_personal_details for a ' +
  'bank-details-only question, there is nothing it could return for that. Answer directly ' +
  'instead, e.g. for "X er bank details" say something like "Bank details are not tracked in ' +
  'this company\'s employee records". ' +
  'Report titles, card labels, table rows and employee data always stay in English exactly ' +
  'as the tools return them.';

// One entry per tools.js function actually exposed to Claude. Kept
// separate from tools.js's own exports (rather than generating this from
// them) because the JSON Schema each tool needs is a decision about the
// AI's own interface, not about the function itself.
const TOOL_DEFS = [
  {
    name: 'get_department_headcount',
    description: 'Get active employee headcount broken down by department.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_location_headcount',
    description: 'Get active employee headcount broken down by work location/site.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_doer_headcount',
    description: 'Get active employee headcount broken down by Reporting DOER (the operational reporting-manager field used for this).',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_joining_this_month',
    description: 'List employees who joined in a given calendar month (current year). Active only by default. Works for ANY named month - pass month for "January te ke join korlo" etc. For relative phrasing ("next month", "last month" - no month actually named), pass monthOffset instead of computing a month number yourself - you cannot reliably compute this without seeing today\'s real date first.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'integer', minimum: 1, maximum: 12, description: 'The calendar month asked about, 1-12 (e.g. 1 for January), ONLY when a specific month was actually named. Omit for "this month"/"next month"/"last month".' },
        monthOffset: { type: 'integer', enum: [-1, 0, 1], description: 'Use instead of month for relative phrasing: -1 = "last month", 0 = "this month" (default, can be omitted), 1 = "next month". Never combine with month.' },
        includeAllStatuses: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include Notice Period/inactive staff (e.g. "notice period soho", "including notice period"). Leave unset for the default (Active only).' }
      }
    }
  },
  {
    name: 'get_joining_trend',
    description: 'Get the joining count trend for the last 12 months.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_pending_confirmations',
    description: 'List employees whose probation confirmation is due this month or next month. Active only by default.',
    input_schema: {
      type: 'object',
      properties: {
        monthOffset: { type: 'integer', enum: [0, 1], description: '0 = this month, 1 = next month' },
        includeAllStatuses: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include Notice Period/inactive staff. Leave unset for the default (Active only).' }
      }
    }
  },
  {
    name: 'get_retirement_this_month',
    description: 'List employees reaching retirement age (58) in a given month. Active only by default. For "this month" omit monthOffset; for "next month"/"porer mase" pass monthOffset:1; for "last month" pass monthOffset:-1. Never compute the month yourself.',
    input_schema: {
      type: 'object',
      properties: {
        monthOffset: { type: 'integer', enum: [-1, 0, 1], description: 'Relative to the current month: -1 = last month, 0 = this month (default, can be omitted), 1 = next month.' },
        includeAllStatuses: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include Notice Period/inactive staff. Leave unset for the default (Active only).' }
      }
    }
  },
  {
    name: 'get_birthdays_this_month',
    description: 'List employees with a birthday in a given calendar month, sorted by day. Active only by default. Works for ANY named month - pass month for "birthdays in October"/"December e kar birthday" etc. For relative phrasing ("next month", "last month" - no month actually named), pass monthOffset instead of computing a month number yourself - you cannot reliably compute this without seeing today\'s real date first.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'integer', minimum: 1, maximum: 12, description: 'The calendar month asked about, 1-12 (e.g. 10 for October, 12 for December), ONLY when a specific month was actually named. Omit for "this month"/"next month"/"last month".' },
        monthOffset: { type: 'integer', enum: [-1, 0, 1], description: 'Use instead of month for relative phrasing: -1 = "last month", 0 = "this month" (default, can be omitted), 1 = "next month". Never combine with month.' },
        includeAllStatuses: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include Notice Period/inactive staff (e.g. "notice period soho October birthday"). Leave unset for the default (Active only).' }
      }
    }
  },
  {
    name: 'get_workforce_movement',
    description: 'Get a summary of department transfers, promotions, company transfers and location transfers over a recent period.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'How many days back to look, e.g. 90 for the last 3 months.' } }
    }
  },
  {
    name: 'get_health_insurance_pending_additions',
    description: 'List employees/family members pending addition to the health insurance policy.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_insurance_status',
    description: 'Get a named employee\'s health insurance/medical coverage status specifically - only for actual insurance/health cover questions. NOT for "who reports to X"/"who is under X" (that\'s get_direct_reports) or any other question about that person. Never mentions premium or sum-insured amounts - those stay out of chat.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The employee\'s name, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'query_employees',
    description: 'General-purpose read-only search over the FULL employee dataset - use this for anything the other tools do not already cover: a specific month\'s birthdays regardless of year, an approximate/partial name, a joining-year breakdown, a tenure-sorted list, "who is under X filtered by department", etc. ALSO use this (not list_employees) whenever the person names specific columns they want, e.g. "Sales department er active staff list - name, designation, phone" means fields:[\'name\',\'designation\',\'contactNumber\'] - contactNumber (phone), emailPersonal, bloodGroup, emergencyContact, permanentAddress, presentAddress, aadhar and pan are all real, available fields here, never say phone/address/etc. aren\'t tracked without checking this tool\'s field list first. Supports filtering on any field, grouping/counting by any field, sorting, and a result limit. Prefer a more specific tool when one exists (e.g. get_department_headcount for a plain department breakdown), but never refuse a question just because no preset tool matches it exactly - use this one instead.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Partial name search - matches all words in any order, so a middle name in between (e.g. searching "Pawan Dhanuka" still finds "Pawan Kumar Dhanuka") is fine.' },
        designation: { type: 'string', description: 'Substring, e.g. "engineer" matches Engineer, Jr. Engineer, Senior Engineer, etc.' },
        department: { type: 'string', description: 'Substring, e.g. "HR" matches "HR DEPT", "civil" matches every Civil sub-department.' },
        status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'NOTICE PERIOD'], description: 'Omit this for the default (Active only) - unless groupBy is itself "status", in which case leave this unset so all statuses show in the breakdown. Only set it when the person specifically named a status, e.g. "inactive staff" -> INACTIVE, "on notice period" -> NOTICE PERIOD.' },
        includeAllStatuses: { type: 'boolean', description: 'Set true ONLY when the person explicitly asked to include inactive/exited staff or "everyone"/"all staff ever" without naming one specific status - e.g. "including inactive", "all staff ever". Leave unset otherwise; the default is Active only.' },
        location: { type: 'string', description: 'Substring on work location/site.' },
        gender: { type: 'string', enum: ['Male', 'Female'] },
        reportingManager: { type: 'string', description: 'Partial name of their manager (HOD-1) - matches all words in any order.' },
        reportingDoer: { type: 'string', description: 'Partial name of their Reporting DOER - matches all words in any order.' },
        collar: { type: 'string', enum: ['White', 'Blue', 'Group-D'] },
        employmentType: { type: 'string', enum: ['Confirmed', 'Probation'] },
        dateFrom: { type: 'string', description: 'Joining date range start, YYYY-MM-DD.' },
        dateTo: { type: 'string', description: 'Joining date range end, YYYY-MM-DD.' },
        dobMonth: { type: 'integer', description: 'Birth month 1-12, ANY year - e.g. 12 for "everyone born in December" regardless of which year.' },
        dobYear: { type: 'integer', description: 'Exact birth year.' },
        dojMonth: { type: 'integer', description: 'Joining month 1-12, ANY year - e.g. 10 for "everyone who ever joined in October".' },
        dojYear: { type: 'integer', description: 'Exact joining year, e.g. 2024 for "joined in 2024".' },
        ageMin: { type: 'integer' },
        ageMax: { type: 'integer' },
        tenureYearsMin: { type: 'number', description: 'Minimum years at this company.' },
        tenureYearsMax: { type: 'number' },
        experienceYearsMin: { type: 'number', description: 'Minimum total career experience in years.' },
        experienceYearsMax: { type: 'number' },
        q: { type: 'string', description: 'Broad free-text search across name/employee ID/email/department/designation/location - use the specific field filters above instead when you know which field the person means.' },
        groupBy: {
          type: 'string',
          enum: ['designation', 'department', 'status', 'location', 'gender', 'collar', 'employmentType', 'reportingManager', 'reportingDoer'],
          description: 'If set, returns COUNTS grouped by this field instead of a list of individuals - use for "X wise" or "how many per Y" questions (e.g. "joined in 2024, department wise" -> dojYear:2024, groupBy:"department").'
        },
        fields: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'employeeId', 'name', 'designation', 'department', 'status', 'location', 'gender', 'dob', 'doj',
              'tenure', 'totalExperience', 'reportingManager', 'reportingDoer', 'collar', 'employmentType',
              'contactNumber', 'emailPersonal', 'bloodGroup', 'emergencyContact', 'permanentAddress', 'presentAddress', 'aadhar', 'pan'
            ]
          },
          description: 'Which columns to show in list mode (ignored when groupBy is set) - choose fields relevant to the question, e.g. include "dob" for a birthday question, "tenure" for a tenure question, "contactNumber" for "with their phone number". Defaults to Emp Code/Name/Designation/Department/Status if omitted.'
        },
        sortBy: {
          type: 'string',
          enum: ['employeeId', 'name', 'designation', 'department', 'status', 'location', 'gender', 'dob', 'doj', 'tenure', 'totalExperience', 'reportingManager', 'reportingDoer', 'collar', 'employmentType', 'tenureYears', 'experienceYears']
        },
        sortDir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: 'Max rows to return in list mode (default 50, max 200).' }
      }
    }
  },
  {
    name: 'get_data_quality_issues',
    description: 'Get a summary of data quality issues in employee records (missing fields, duplicate IDs).',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_insights',
    description: 'Get a list of automatically generated workforce insights (top department, top location, upcoming birthdays, etc).',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_demographics',
    description: 'Get a breakdown of active employees by age, gender, collar category (White/Blue/Group-D), or tenure (time at this company, bucketed, with the average).',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['age', 'gender', 'collar', 'tenure'] } },
      required: ['kind']
    }
  },
  {
    name: 'find_employee',
    description: 'Search for an employee by name or employee ID.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name or employee ID to search for.' } },
      required: ['query']
    }
  },
  {
    name: 'get_direct_reports',
    description: 'DOWNWARD direction only - list employees who report TO a named manager (their team, below them). Use when X is the manager/senior person in the question: "who reports to X", "who\'s on X\'s team", "X er under e kara ache" (who is under X), "X ke under kitne log hain" (how many under X), "X ke under kaun kaun hai" (who all is under X), "X ka team". Do NOT use this for the opposite direction (X\'s OWN manager/HOD) - see get_reporting_manager for that. Nothing to do with health insurance/benefits - never call get_insurance_status for this kind of question.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The manager/DOER\'s name, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'get_reporting_manager',
    description: 'UPWARD direction only - find who a named employee reports TO (their own manager/HOD, one person above them) - the opposite of get_direct_reports. Use when X is the junior/subject of the question, asking about X\'s OWN position: "X er HOD ke" (who is X\'s HOD), "X kar under e" / "X kis ke under hai" / "X kiske under hai" (under WHOM is X), "X kisko report karta hai" (who does X report to), "who is X\'s reporting manager", "who does X report to", "X under who". Contrast: "X er under e kara ache" (who is under X) is the OPPOSITE question - that one is get_direct_reports.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The employee whose manager/HOD is being asked about, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'get_employee_detail',
    description: 'Get a single named employee\'s work profile: Employee ID, Designation, Department, Status, Date of Birth, Tenure, Total Experience, Reporting Manager. This tool never returns personal/sensitive fields (contact number, personal email, blood group, emergency contact, address, Aadhar, PAN) - use get_personal_details for those instead, never claim this tool has them or that they don\'t exist.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The employee\'s name or ID, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'get_personal_details',
    description: 'Get a named employee\'s personal details: contact number, personal email, blood group, emergency contact, permanent/present address, Aadhar, PAN. These columns DO exist in the data - never claim there\'s no such data. Use this whenever someone asks for any of these specific fields.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The employee\'s name or ID, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'list_employees',
    description: 'Get a filtered, sortable list with a FIXED set of columns (Emp Code, Name, Designation, Department, Status, DOJ) - use for a plain list with no specific columns named (e.g. "list the engineers in Civil", "who is in the Sales department"). You DO have access to employee lists via this tool - never say you don\'t. If the person names which columns they want (e.g. "name, designation, phone" or "with their contact number"), use query_employees with fields instead - this tool cannot add or change its columns. The full list is already shown in the results card below your reply - do not repeat it as a table in your own text, just a short one-line summary.',
    input_schema: {
      type: 'object',
      properties: {
        designation: { type: 'string', description: 'Substring match on designation/title, e.g. "engineer" matches Engineer, Jr. Engineer, Senior Engineer, etc.' },
        department: { type: 'string', description: 'Exact department name.' },
        status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'NOTICE PERIOD'], description: 'Omit this for the default (Active only). Only set it when the person specifically named a status, e.g. "inactive staff" -> INACTIVE, "who is on notice period" -> NOTICE PERIOD.' },
        includeAllStatuses: { type: 'boolean', description: 'Set true ONLY when the person explicitly asked to include inactive/exited staff or "everyone"/"all staff ever" without naming one specific status - e.g. "including inactive", "all staff ever". Leave unset otherwise; the default is Active only.' },
        dateFrom: { type: 'string', description: 'Joining date range start, YYYY-MM-DD.' },
        dateTo: { type: 'string', description: 'Joining date range end, YYYY-MM-DD.' },
        q: { type: 'string', description: 'Free-text search across name, employee ID, email, department, designation, location.' },
        tenureYearsMin: { type: 'number', description: 'Minimum years at this company (tenure), e.g. 5 for "5+ years with us".' },
        tenureYearsMax: { type: 'number', description: 'Maximum years at this company (tenure).' },
        experienceYearsMin: { type: 'number', description: 'Minimum total career experience in years, e.g. 10 for "10+ years experience".' },
        experienceYearsMax: { type: 'number', description: 'Maximum total career experience in years.' },
        sortBy: { type: 'string', enum: ['name', 'employeeId', 'designation', 'department', 'doj'] },
        sortDir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: 'Max rows to return (default 50, max 200).' }
      }
    }
  },
  {
    name: 'group_employees',
    description: 'Count employees grouped by one field (department, designation, status, location, gender, or category), optionally filtered first - use this for "how many X per Y" questions that don\'t match an existing preset report, e.g. "how many engineers per department".',
    input_schema: {
      type: 'object',
      properties: {
        groupBy: { type: 'string', enum: ['department', 'designation', 'status', 'location', 'gender', 'collar'] },
        designation: { type: 'string', description: 'Substring match on designation/title to filter by first, e.g. "engineer".' },
        department: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'NOTICE PERIOD'], description: 'Omit this for the default (Active only) - unless groupBy is itself "status", in which case leave this unset so all statuses show in the breakdown. Only set it when the person specifically named a status.' },
        includeAllStatuses: { type: 'boolean', description: 'Set true ONLY when the person explicitly asked to include inactive/exited staff or "everyone"/"all staff ever" without naming one specific status. Leave unset otherwise; the default is Active only (except when groupBy is "status" itself, which always shows every status).' },
        dateFrom: { type: 'string', description: 'Joining date range start, YYYY-MM-DD.' },
        dateTo: { type: 'string', description: 'Joining date range end, YYYY-MM-DD.' },
        q: { type: 'string', description: 'Free-text search to filter by first.' },
        tenureYearsMin: { type: 'number', description: 'Minimum years at this company (tenure), to filter by first.' },
        tenureYearsMax: { type: 'number', description: 'Maximum years at this company (tenure), to filter by first.' },
        experienceYearsMin: { type: 'number', description: 'Minimum total career experience in years, to filter by first.' },
        experienceYearsMax: { type: 'number', description: 'Maximum total career experience in years, to filter by first.' }
      },
      required: ['groupBy']
    }
  },
  {
    name: 'prepare_letter',
    description: 'Prepare a promotion/increment, increment-only, or confirmation letter for a named employee, ready to open in the Letter Generator.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The employee\'s name, as mentioned by the user.' },
        letterType: { type: 'string', enum: ['promotion', 'increment', 'confirmation'] }
      },
      required: ['name', 'letterType']
    }
  },
  {
    name: 'navigate_to_view',
    description: 'Open an existing section of the app for the user (use this for requests like "show the organization chart" that are really just navigation, not a data report).',
    input_schema: {
      type: 'object',
      properties: { view: { type: 'string', enum: Object.keys(tools.NAVIGABLE_VIEWS) } },
      required: ['view']
    }
  },
  {
    name: 'no_data_needed',
    description: 'Call this for anything that is not a request for specific employee facts or numbers - greetings, thanks, small talk, general knowledge, opinions, advice, or drafting free text that does not need real employee data. Returns nothing - just lets you reply conversationally and freely afterwards, without inventing employee data.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_current_datetime',
    description: 'Get the real current date, day of week, and time (India Standard Time). Call this whenever a question needs today\'s date, the day of the week, or the current time - never guess it.',
    input_schema: { type: 'object', properties: {} }
  }
];

// Maps a tool_use name back to the real tools.js function + how to pull
// its arguments out of Claude's own (already-validated-by-schema) input.
const TOOL_RUNNERS = {
  get_department_headcount: () => tools.departmentHeadcount(),
  get_location_headcount: () => tools.locationHeadcount(),
  get_doer_headcount: () => tools.doerHeadcount(),
  get_joining_this_month: (input) => tools.joiningThisMonth(input.month, input.includeAllStatuses, input.monthOffset),
  get_joining_trend: () => tools.joiningTrend(),
  get_pending_confirmations: (input) => tools.pendingConfirmations(input.monthOffset || 0, input.includeAllStatuses),
  get_retirement_this_month: (input) => tools.retirementThisMonth(input.includeAllStatuses, input.monthOffset),
  get_birthdays_this_month: (input) => tools.birthdaysThisMonth(input.month, input.includeAllStatuses, input.monthOffset),
  get_workforce_movement: (input) => tools.workforceMovement(input.days || 90),
  get_health_insurance_pending_additions: () => tools.healthInsurancePendingAdditions(),
  get_insurance_status: (input) => tools.insuranceStatus(input.name),
  query_employees: (input) => tools.queryEmployees(input),
  get_data_quality_issues: () => tools.dataQualityIssues(),
  get_insights: () => tools.insightsSummary(),
  get_demographics: (input) => tools.demographics(input.kind),
  find_employee: (input) => tools.findEmployee(input.query),
  get_direct_reports: (input) => tools.directReports(input.name),
  get_reporting_manager: (input) => tools.getReportingManager(input.name),
  get_employee_detail: (input) => tools.employeeDetail(input.name),
  get_personal_details: (input) => tools.getPersonalDetails(input.name),
  list_employees: (input) => tools.listEmployees(input),
  group_employees: (input) => tools.groupEmployees(input, input.groupBy),
  prepare_letter: (input) => tools.prepareLetter({ name: input.name, letterType: input.letterType }),
  navigate_to_view: (input) => tools.navigateToView(input.view),
  no_data_needed: () => ({ title: null, rows: null, actions: null }),
  get_current_datetime: () => tools.currentDateTime()
};

// The language rule lives in SYSTEM_PROMPT's first line, but earlier turns
// in `history` are real examples of whatever language they happened to be
// in - the model can end up pattern-matching the conversation's dominant
// language instead of the latest message (confirmed live: a run of
// Banglish turns dragged a later plain-English message into a Banglish
// reply). Restating the rule as a second content block directly attached
// to the CURRENT user message, right where the model is about to answer,
// counters that recency/majority bias without touching how the message
// itself is stored or displayed anywhere else.
const LANGUAGE_REMINDER = 'Reminder: match the language and script of the message below only.';

function toClaudeMessages(history, message) {
  const msgs = (history || [])
    .filter((h) => h && h.text)
    .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text }));
  msgs.push({
    role: 'user',
    content: [
      { type: 'text', text: LANGUAGE_REMINDER },
      { type: 'text', text: message }
    ]
  });
  return msgs;
}

async function callClaude(apiKey, messages, forceToolCall) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json'
    },
    body: JSON.stringify(Object.assign(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFS,
        messages
      },
      // Forced on the FIRST call only - closes the hallucination hole: the
      // model physically cannot skip straight to a text answer (and invent
      // a name/number) without going through a real tool first, not even
      // for greetings/small talk (no_data_needed covers those). The
      // follow-up call, after it's already seen the real tool result, is
      // left unset (defaults to 'auto') so it can just answer in text.
      forceToolCall ? { tool_choice: { type: 'any' } } : {}
    ))
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error('Claude API error ' + resp.status + (bodyText ? ': ' + bodyText.slice(0, 200) : ''));
  }
  return resp.json();
}

function extractText(content) {
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

// The system prompt requires every reply to start with a [[PLAIN]] or
// [[CARD]] marker (stripped before the person ever sees it) - this is how
// the model tells us whether it answered a simple factual question (in
// which case the tool's card/buttons are suppressed entirely, even though
// the tool itself returned them, since the SAME tool serves both a "what
// is X's DOB" question and a "show me everyone in X" question) or a
// list/report request (card and buttons shown as the tool built them).
// Falls back to showing the card if the marker is missing/unrecognised -
// erring toward showing real data rather than silently hiding it.
const REPLY_MARKER_RE = /^\s*\[\[(PLAIN|CARD)\]\]\s*/;

// See openaiProvider.js's buildCardFallback for why this exists: the
// model can emit only the marker and no text after it, and a static
// fallback then shows no number at all for a count/total question.
// Building the fallback from the tool result's own title/footer keeps
// the real figure correct even on a total content dropout.
function buildCardFallback(card) {
  if (!card || !card.footer || typeof card.footer.value === 'undefined') return null;
  const title = String(card.title || 'Result').replace(/\s*\(Top \d+\)\s*$/, '');
  let sentence = title + ' - ' + card.footer.label + ': ' + card.footer.value + '.';
  const shown = (card.rows || card.tableRows || []).length;
  if (shown && card.footer.value > shown) {
    sentence += ' First ' + shown + ' shown, rest in the card.';
  }
  return sentence;
}

function finalizeReply(rawContent, card, actions, fallbackText) {
  const raw = rawContent || '';
  const match = raw.match(REPLY_MARKER_RE);
  const isPlain = Boolean(match && match[1] === 'PLAIN');
  const cleaned = (match ? raw.slice(match[0].length) : raw).trim();
  return {
    reply: cleaned || buildCardFallback(card) || fallbackText,
    card: isPlain ? null : card,
    actions: isPlain ? null : actions
  };
}

async function getResponse({ message, history, user }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // provider.js is only supposed to reach this file when a key exists,
    // but this guard makes that assumption impossible to violate silently.
    throw new Error('claudeProvider.getResponse called without ANTHROPIC_API_KEY set');
  }

  const messages = toClaudeMessages(history, message);
  let data = await callClaude(apiKey, messages, true);

  // At most one tool round-trip - every tool here is a single, direct
  // lookup with no reason for Claude to chain multiple calls together;
  // capping it keeps latency and cost bounded and avoids ever looping.
  if (data.stop_reason === 'tool_use') {
    const toolUseBlock = data.content.find((b) => b.type === 'tool_use');
    const runner = toolUseBlock && TOOL_RUNNERS[toolUseBlock.name];
    // Audit log: which tool, when, for whom - never the data it returns
    // (see toolCallLog.js). Logged regardless of whether the tool name
    // resolved, so an unrecognised tool_use attempt is visible too.
    toolCallLog.recordToolCall({
      email: user && user.email,
      provider: 'claude',
      toolName: toolUseBlock && toolUseBlock.name,
      params: (toolUseBlock && toolUseBlock.input) || {}
    });
    let toolResult;
    let card = null;
    let actions = null;
    try {
      toolResult = runner ? await runner(toolUseBlock.input || {}, user) : { error: 'Unknown tool: ' + toolUseBlock.name };
      if (toolResult && !toolResult.error) {
        card = toolResult.title
          ? {
              title: toolResult.title,
              rows: toolResult.rows || null,
              columns: toolResult.columns || null,
              tableRows: toolResult.tableRows || null,
              // Full, untruncated data for View Report/Download - never
              // sent to the model (see the tool-result JSON built below,
              // which excludes these two fields), purely for the browser.
              fullRows: toolResult.fullRows || null,
              fullTableRows: toolResult.fullTableRows || null,
              footer: toolResult.footer || null,
              note: toolResult.note || null
            }
          : null;
        actions = toolResult.actions || null;
      }
    } catch (err) {
      toolResult = { error: err.message };
    }

    // fullRows/fullTableRows (the untruncated data behind View Report/
    // Download) are deliberately left out of what the model sees - same
    // reasoning as openaiProvider.js.
    const modelFacingToolResult = Object.assign({}, toolResult, { fullRows: undefined, fullTableRows: undefined });
    const followUpMessages = messages.concat([
      { role: 'assistant', content: data.content },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: JSON.stringify(modelFacingToolResult).slice(0, 4000) }]
      }
    ]);
    data = await callClaude(apiKey, followUpMessages);
    return finalizeReply(extractText(data.content), card, actions, 'Here you go.');
  }

  return finalizeReply(extractText(data.content), null, null, "I'm not sure how to help with that yet.");
}

module.exports = { getResponse };
