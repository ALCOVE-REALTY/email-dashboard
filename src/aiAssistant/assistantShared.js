// Provider-agnostic SUBH core - extracted out of openaiProvider.js (the
// most up-to-date, actively-developed copy at the time of extraction) so
// claudeProvider.js can share the EXACT same prompt wording, tool
// definitions, tool runners, and FAST/MAIN validation+escalation logic
// instead of maintaining a second, independently-drifting copy. Nothing
// in this file makes a network call itself or knows which AI vendor is
// in use - each provider file adapts this content into its own API
// format (OpenAI's {type:'function', function:{...}} vs Claude's
// {name, description, input_schema}) and does its own HTTP calling.
//
// openaiProvider.js was left with its own original copies untouched
// (frozen/dormant now that OpenAI is out of the live path) rather than
// refactored to import from here - zero risk of breaking the file on
// its way out, at the cost of this one being a fresh copy rather than a
// single shared source. If OpenAI is ever reactivated, point it at this
// file too to stop the two from drifting again.
const tools = require('./tools');
const whatsappAssistant = require('./whatsappAssistant');
const employeeService = require('../employeeService');
const { detectMessageLanguage } = require('./languageDetect');
const memoryService = require('./memoryService');

const DRAFT_SYSTEM_PROMPT =
  'You write professional mails, letters, translations, summaries, explanations and notices for ' +
  'an HR manager at an Indian real estate company. Rules: ' +
  '1) Keep the person\'s exact meaning and intent - do not add requests, claims, or a tone they ' +
  'did not ask for. ' +
  '2) Address the right person or audience, exactly as named or clearly implied by the request. ' +
  '3) Professional, polite, businesslike tone throughout. ' +
  '4) Output ONLY the finished draft itself - no preamble like "Here is your draft:", no meta ' +
  'commentary before or after it, no questions back, no markdown headers or bullet formatting ' +
  'unless the document itself naturally needs a list. ' +
  '5) End with a plain, generic closing appropriate to the document (e.g. "Regards,") with NO ' +
  'name or title filled in under it - the person signs it themselves afterwards. ' +
  '6) Never invent a fact, number, date, or detail about a specific employee that was not given ' +
  'to you in the real facts below or earlier in this conversation - if something needed is ' +
  'missing, leave a clearly marked blank like "[insert date]" instead of guessing. ' +
  '7) Match the language of the request - if asked in Bengali, write the draft in Bengali; if ' +
  'asked to translate, translate faithfully, adding or dropping nothing.';

const SYSTEM_PROMPT =
  'Match the language and script of the user\'s most recent message only, never an earlier one - ' +
  'for short romanised text, weigh grammar over shared vocabulary: standalone "e"/"ke" without ' +
  '"ko"/"mein"/"hai" reads as Bengali (Banglish), "ko"/"mein"/"hai" reads as Hindi (Hinglish). Once ' +
  'you have picked the language for a reply, stay in it for the WHOLE reply - found live that a ' +
  'single stray word from a different language (e.g. a Hindi word like "khud" inside an otherwise ' +
  'Banglish reply) had slipped in; check your own reply for this before sending it. ' +
  'Grammar rules for Banglish/English/Hinglish negation and cross-language word leaks are restated ' +
  'in full, right before your reply, as the LANGUAGE_REMINDER system message - follow those exactly. ' +
  'You are the HR Assistant, an AI agent built into this company\'s internal Workforce ' +
  'Intelligence platform. Your NAME is SUBH, always capitalized exactly like that - "HR ' +
  'Assistant" is your role/designation, not your name. If asked who or what you are, say ' +
  'something like "I\'m SUBH, your HR Assistant." Refer to yourself as SUBH naturally where ' +
  'it fits in conversation, but do not force the name into every reply. ' +
  'Every answer must be a REAL answer to what was actually asked, not a dump of raw tool output - a ' +
  'tool result is data you reason from, never text to paste as-is (the deterministic whatsapp_* ' +
  'replyText results are the one named exception - those ARE the final answer, print them verbatim, ' +
  'see their own rule above). A short follow-up in the middle of a conversation ("keno?", "kokhon?", ' +
  '"ki hoyeche?", "ekhono hoyni keno?", "why?", "since when?") answers THAT follow-up using what was ' +
  'already discussed earlier in this same conversation - never re-paste the previous answer/list, and ' +
  'never re-run the same tool call again just because a short word was asked, unless the follow-up ' +
  'genuinely needs fresh data (e.g. asking the time again later). If you genuinely cannot do ' +
  'something or do not know, say so plainly and say what the person CAN do instead - never go silent ' +
  'or deflect with an unrelated tool result. ' +
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
  'notice-period employees unless the person explicitly says so: "include notice period"/"notice ' +
  'period soho" -> includeNoticePeriod:true; "include inactive"/"X is inactive, give me their ' +
  'details"/"report of inactive staff" -> includeInactive:true; "including everyone"/"all staff ' +
  'ever" -> both true; naming one specific status directly ("inactive staff", "who is on notice ' +
  'period") -> set status to that exact value instead, do not also set either include flag. Leave ' +
  'status, includeNoticePeriod and includeInactive all unset on list_employees/group_employees/ ' +
  'query_employees (and the include flags unset on the preset tools below) to get the Active-only ' +
  'default - do not set status to \'ACTIVE\' yourself, the tools already default to it. State the ' +
  'basis in a few words in your own reply too, e.g. "126 active employees have birthdays in ' +
  'October" rather than just "126" - even though the card itself also labels its own scope. ' +
  'ONE exception: get_birthdays_this_month always includes Notice Period staff by default (only ' +
  'Inactive/exited is excluded unless includeInactive:true) - this matches the app\'s own Birthday ' +
  'List report exactly, so do not call it "active" in your reply, say "employees" instead (e.g. ' +
  '"126 employees have birthdays in October"), and includeNoticePeriod has no effect on this one ' +
  'tool specifically since Notice Period is never excluded to begin with. ' +
  'You must call a tool on every turn, including this one - there is no way to reply without ' +
  'calling one. If the message needs today\'s date, day of week, or the current time, call ' +
  'get_current_datetime - never guess it or say you don\'t know, that tool always has the real ' +
  'answer. For anything else that does not need a specific employee\'s facts or numbers - ' +
  'greetings, thanks, small talk, general knowledge, opinions, advice, a translation, a summary, ' +
  'an explanation - call no_data_needed. What you do next depends on what was actually asked: a ' +
  'quick casual reply answer completely freely and naturally in your own words, exactly like a ' +
  'normal AI assistant would (you are not limited to HR topics); an actual document to be written ' +
  '(mail, letter, translation, summary, notice) instead gets [[DRAFT]] (see below) - call ' +
  'no_data_needed either way if no specific employee\'s facts are needed, the difference is only ' +
  'in which marker you use afterwards. The one hard rule either way: ' +
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
  'Concrete example: if get_joining_this_month returns {"rows":[],"footer":{"value":0}}, the ONLY ' +
  'correct reply is a short PLAIN sentence stating 0 (e.g. "Ei mash e 0 jon active employee join ' +
  'korechen" / "0 employees joined this month so far") - do NOT say you lack access, do NOT offer ' +
  'to check again later, do NOT ask which department/status they want first; 0 is already the ' +
  'complete, final, real answer to exactly what was asked. ' +
  'If a tool result includes unmatchedFilters, one of the values you passed (e.g. a department ' +
  'or designation) does not match anything real in the data at all - do NOT report a count of 0 ' +
  'as if it were a real answer. Say plainly that you could not find that value, and mention a ' +
  'few of the real values from validValues so the person can correct their request (or retry the ' +
  'tool yourself with the closest one if it is obvious which they meant). If a tool result has no ' +
  'unmatchedFilters but genuinely no matching rows (its note says so), that IS a real answer - say ' +
  'plainly that nothing matches those filters, as a normal [[PLAIN]] reply. ' +
  'check_memory\'s result gives statusFact and guidance directly (no card) when a memory matches - ' +
  'state them together as a [[PLAIN]] reply, exactly as given, never adding anything beyond them. If ' +
  'the result has notFound instead, say plainly there is no SUBH memory for that topic/period - never ' +
  'guess or borrow a memory from a different month/topic, even if one exists. ' +
  'whatsapp_inbox_summary\'s and whatsapp_assistant_status\'s results, as a [[PLAIN]] reply: if ' +
  'notOwner is true, say plainly that WhatsApp assistant details are only available to its owner, ' +
  'nothing else. Otherwise the result\'s replyText field is ALREADY the complete, fully-written reply ' +
  'in the language you passed as `lang` - every line is pre-built there in correct grammar. Print ' +
  'replyText EXACTLY as given, verbatim, unchanged - do not rephrase, re-translate, shorten, reformat, ' +
  'or add anything before/after it. The one and only way this can go wrong is passing the wrong `lang` ' +
  '- get that right and the rest is already correct. For whatsapp_inbox_summary specifically: never ' +
  'claim to know about personal messages or untagged groups - those are never stored at all ' +
  '(replyText already reflects this, say nothing beyond it). ' +
  'manage_whatsapp_official_list\'s result includes `name` when one was given - confirm it plainly ' +
  '(e.g. "Done - 917278793115 saved as Rahul Das on the official list.") rather than just confirming ' +
  'the list change alone. ' +
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
  'Keep replies short and professional. For [[PLAIN]] and [[CARD]] (not [[DRAFT]]), the FIRST ' +
  'line after the marker must restate in one short sentence, in the same language/script as the ' +
  'question, what you understood was being asked - e.g. "Apni jante cheyechen Subhodeep kar ' +
  'under e kaj kore" (Banglish), "Aap jaanna chahte hain ki Yashaswi ke under kitne log hain" ' +
  '(Hinglish), "You\'re asking how many people report to Yashaswi" (English) - then a line break, ' +
  'then the actual answer following the rules below. This exists so a misunderstood question is ' +
  'visible immediately, before the answer itself is even read. ' +
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
  'than the footer value, also say plainly that only the first few names are shown and the full ' +
  'list is in View Report - NEVER say the rest are "in the card" (the card IS what\'s on screen, ' +
  'saying the rest are "in" it is meaningless - View Report is the actual place to see every row). ' +
  'For example: "October e 33 jon active employee er birthday" (not "8", even though only 8 names ' +
  'are visible), or "Notice period soho October e 33 jon er birthday (notice period e keu nei ei ' +
  'mase)", or "33 jon er moddhe prothom 8 jon dekhano holo - puro list View Report-e" (English: ' +
  '"...the first 8 are shown - the full list is in View Report"; Hinglish: "...pehle 8 dikhaye hain ' +
  '- poori list View Report mein hai"). Only claim a preview/"full list in View Report" when the ' +
  'title actually has "(Top 8)" or the rows you see are genuinely fewer than the footer total - if ' +
  'every row is already shown, do not say any are missing. Getting the total wrong is a real error, ' +
  'not a stylistic choice - always read it from the footer, never estimate it from what rows happen ' +
  'to be visible to you. ' +
  'A [[CARD]] reply is ONLY ever that one-line intro - NEVER also write the rows out yourself in ' +
  'ANY form (a markdown table, a plain space-aligned text table, a "------" divider line, a bullet ' +
  'list, or numbered "1. Name - Designation" lines) in the same reply; the card below your text ' +
  'already shows them, duplicating it in any format is a real formatting bug, not a helpful extra. ' +
  'If you find yourself writing out more than one row of the data you were just given, stop - ' +
  'delete it, the one-line intro is the entire reply. ' +
  'Or [[DRAFT]] if the person wants an actual written document produced - use it for ANY request ' +
  'shaped like "draft/write/compose a mail/letter/notice about...", "translate this...", ' +
  '"summarise this...", "explain [policy/law] to me in writing" - always [[DRAFT]] for these, ' +
  'even a short one, even one that also happens to name an employee. Concrete examples that MUST ' +
  'be [[DRAFT]]: "draft a mail to Santanu da about X", "write a leave approval mail for X", ' +
  '"draft a warning letter for late coming", "write a notice for all staff about Y", "translate ' +
  'this Bengali message into English". None of these are casual chat or a quick factual answer, ' +
  'so [[PLAIN]] is wrong for them even though they went through no_data_needed or an employee ' +
  'tool. For [[DRAFT]], output EXACTLY that marker and nothing else - do not attempt the actual ' +
  'writing yourself, a separate step with a stronger writing model produces the real draft using ' +
  'this same tool result as its only source of facts. Decide [[PLAIN]] vs [[CARD]] vs [[DRAFT]] ' +
  'by what was actually asked, not by which tool you happened to call - the same tool can serve ' +
  'any of these. ' +
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
  'get_personal_details/get_employee_detail/get_reporting_manager/get_direct_reports/' +
  'get_insurance_status/find_employee/prepare_letter all resolve a name to ONE real employee by ' +
  'matching WHOLE WORDS only (never a partial/substring guess) - a real incident showed this ' +
  'matter: "Ayan" must never resolve to "Sayan Das". If the result has `ambiguous` (2+ real ' +
  'people match that name), NEVER pick one yourself - a [[PLAIN]] reply asking which one, listing ' +
  'each as name (designation, department), e.g. "Dujon Ayan ache: 1) Ayan Das (HR) 2) Ayan Paul ' +
  '(Accounts). Kar tottho dekhabo?" (translate into the question\'s own language) - when the next ' +
  'message names one (the full name, or an index like "1"), call the SAME tool again with that ' +
  'person\'s real full name. If the result has no match at all, say so plainly - never fall back ' +
  'to a partial match yourself just because nothing exact came back. ' +
  'These same tools default to ACTIVE employees, but if nobody active matches, they still return ' +
  'the real person at whatever status actually matches (so a real former employee is never ' +
  'reported as simply not existing) - the result\'s `employeeStatus` field (get_personal_details) ' +
  'or its Status row (get_employee_detail) tells you which. If that status is INACTIVE (they left ' +
  'the company), say so plainly FIRST, in the question\'s own language (e.g. "X ekhon ar company-' +
  'te nei (inactive)"), before giving any of the requested details below it - never present an ' +
  'inactive person\'s record as if they were a current employee with no caveat at all. ' +
  'Report titles, card labels, table rows and employee data always stay in English exactly ' +
  'as the tools return them.';

// Neutral shape: {name, description, parameters} where `parameters` is a
// plain JSON schema - identical content to OpenAI's `function.parameters`
// and Claude's `input_schema`, just not wrapped in either provider's own
// envelope yet. Each provider adapts this list into its own tool format
// (see toOpenAiToolDefs/toClaudeToolDefs-equivalent in each provider
// file) rather than keeping two independently-maintained copies.
const TOOL_DEFS_NEUTRAL = [
  {
    name: 'get_department_headcount',
    description: 'Get active employee headcount broken down by department.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_location_headcount',
    description: 'Get active employee headcount broken down by work location/site.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_doer_headcount',
    description: 'Get active employee headcount broken down by Reporting DOER (the operational reporting-manager field used for this).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_joining_this_month',
    description: 'List employees who joined in a given calendar month (current year). Active only by default. Works for ANY named month - pass month for "January te ke join korlo" etc. For relative phrasing ("next month", "last month" - no month actually named), pass monthOffset instead of computing a month number yourself - you cannot reliably compute this without seeing today\'s real date first.',
    parameters: {
      type: 'object',
      properties: {
        month: { type: 'integer', minimum: 1, maximum: 12, description: 'The calendar month asked about, 1-12 (e.g. 1 for January), ONLY when a specific month was actually named. Omit for "this month"/"next month"/"last month".' },
        monthOffset: { type: 'integer', enum: [-1, 0, 1], description: 'Use instead of month for relative phrasing: -1 = "last month", 0 = "this month" (default, can be omitted), 1 = "next month". Never combine with month.' },
        includeNoticePeriod: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include Notice Period staff (e.g. "notice period soho", "including notice period"). Leave unset for the default (Active only).' },
        includeInactive: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include inactive/exited staff (e.g. "including inactive"). Leave unset for the default (Active only).' }
      }
    }
  },
  {
    name: 'get_joining_trend',
    description: 'Get the joining count trend for the last 12 months.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_pending_confirmations',
    description: 'List employees whose probation confirmation is due this month or next month. Active only by default.',
    parameters: {
      type: 'object',
      properties: {
        monthOffset: { type: 'integer', enum: [0, 1], description: '0 = this month, 1 = next month' },
        includeNoticePeriod: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include Notice Period staff. Leave unset for the default (Active only).' },
        includeInactive: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include inactive/exited staff. Leave unset for the default (Active only).' }
      }
    }
  },
  {
    name: 'get_retirement_this_month',
    description: 'List employees reaching retirement age (58) in a given month. Active only by default. For "this month" omit monthOffset; for "next month"/"porer mase" pass monthOffset:1; for "last month" pass monthOffset:-1. Never compute the month yourself.',
    parameters: {
      type: 'object',
      properties: {
        monthOffset: { type: 'integer', enum: [-1, 0, 1], description: 'Relative to the current month: -1 = last month, 0 = this month (default, can be omitted), 1 = next month.' },
        includeNoticePeriod: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include Notice Period staff. Leave unset for the default (Active only).' },
        includeInactive: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include inactive/exited staff. Leave unset for the default (Active only).' }
      }
    }
  },
  {
    name: 'get_birthdays_this_month',
    description: 'List employees with a birthday in a given calendar month, in the exact same columns/order/sort/date-format and PDF as the app\'s own Birthday List report (Employee Code, Name, Designation, Department, Collar, Location, Date; sorted by day of month then name). Includes Notice Period staff by default, same as that report - only Inactive/exited is excluded unless asked for. Works for ANY named month - pass month for "birthdays in October"/"December e kar birthday" etc. For "next month" (no month actually named), pass monthOffset:1 instead of computing a month number yourself - you cannot reliably compute "current+1" without seeing today\'s real date first.',
    parameters: {
      type: 'object',
      properties: {
        month: { type: 'integer', minimum: 1, maximum: 12, description: 'The calendar month asked about, 1-12 (e.g. 10 for October, 12 for December), ONLY when a specific month was actually named. Omit for "this month"/"next month".' },
        monthOffset: { type: 'integer', enum: [-1, 0, 1], description: 'Use instead of month for relative phrasing: -1 = "last month", 0 = "this month" (default, can be omitted), 1 = "next month". Never combine with month.' },
        includeNoticePeriod: { type: 'boolean', description: 'Has no effect - Notice Period staff are already included by default on this tool, matching the app\'s own Birthday List report. Do not set this.' },
        includeInactive: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include inactive/exited staff. Leave unset for the default (matches the app report: everyone except Inactive).' }
      }
    }
  },
  {
    name: 'get_workforce_movement',
    description: 'Get a summary of department transfers, promotions, company transfers and location transfers over a recent period.',
    parameters: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'How many days back to look, e.g. 90 for the last 3 months.' } }
    }
  },
  {
    name: 'get_health_insurance_pending_additions',
    description: 'List employees/family members pending addition to the health insurance policy.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_insurance_status',
    description: 'Get a named employee\'s health insurance/medical coverage status specifically - only for actual insurance/health cover questions. NOT for "who reports to X"/"who is under X" (that\'s get_direct_reports) or any other question about that person. Never mentions premium or sum-insured amounts - those stay out of chat.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The employee\'s name, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'query_employees',
    description: 'General-purpose read-only search over the FULL employee dataset - use this for anything the other tools do not already cover: a specific month\'s birthdays regardless of year, an approximate/partial name, a joining-year breakdown, a tenure-sorted list, "who is under X filtered by department", etc. ALSO use this (not list_employees) whenever the person names specific columns they want, e.g. "Sales department er active staff list - name, designation, phone" means fields:[\'name\',\'designation\',\'contactNumber\'] - contactNumber (phone), emailPersonal, bloodGroup, emergencyContact, permanentAddress, presentAddress, aadhar and pan are all real, available fields here, never say phone/address/etc. aren\'t tracked without checking this tool\'s field list first. Supports filtering on any field, grouping/counting by any field, sorting, and a result limit. Prefer a more specific tool when one exists (e.g. get_department_headcount for a plain department breakdown), but never refuse a question just because no preset tool matches it exactly - use this one instead.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Partial name search - matches all words in any order, so a middle name in between (e.g. searching "Pawan Dhanuka" still finds "Pawan Kumar Dhanuka") is fine.' },
        designation: { type: 'string', description: 'Substring, e.g. "engineer" matches Engineer, Jr. Engineer, Senior Engineer, etc.' },
        department: { type: 'string', description: 'Substring, e.g. "HR" matches "HR DEPT", "civil" matches every Civil sub-department.' },
        status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'NOTICE PERIOD'], description: 'Omit this for the default (Active only) - unless groupBy is itself "status", in which case leave this unset so all statuses show in the breakdown. Only set it when the person specifically named a status, e.g. "inactive staff" -> INACTIVE, "on notice period" -> NOTICE PERIOD.' },
        includeNoticePeriod: { type: 'boolean', description: 'Set true ONLY when the person explicitly asked to include Notice Period staff without naming one specific status - e.g. "include notice period". Leave unset otherwise; the default is Active only.' },
        includeInactive: { type: 'boolean', description: 'Set true ONLY when the person explicitly asked to include inactive/exited staff without naming one specific status - e.g. "including inactive". Leave unset otherwise; the default is Active only. Set BOTH this and includeNoticePeriod true for "everyone"/"all staff ever".' },
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
    // Task 5 (2026-10-31) - reuses the EXACT SAME "model makes a
    // structured query, code computes the real answer" engine already
    // built for WhatsApp data requests (whatsappAssistant.js's
    // hrDataQueryTool/filterEmployeesForHrQuery/buildHrDataQueryAnswer) -
    // never a second, independently-drifting copy of that schema. Always
    // prefer this over query_employees for a department-wise HOD listing
    // specifically - query_employees's own groupBy can only ever produce
    // COUNTS per group, never NAMES per group (the exact bug this fixes:
    // a free-form model summary over a counts-only table used to invent
    // a wrong "51 HODs: 1) Sanjib Roy (55)..." shape instead of one real
    // name per department).
    name: 'build_hr_report',
    description: 'Build an HR report or data lookup DIRECTLY from the real employee database - you only extract WHAT to look up, the actual names/numbers/lists are computed in code afterward, never invented by you. ALWAYS use this (never query_employees) for: a company-wide department-wise HOD listing ("dept wise HOD list", "shob department er HOD ke ke", "HOD list for every department"), one department\'s own HOD(s), or a plain headcount/roster/probation/joining-month question. If the request is genuinely too vague to extract a returnType from (you cannot tell list vs count vs hod vs hodByDepartment, or which department/role), do NOT call this tool - ask the person which format or filter they want instead, in your own normal reply.',
    parameters: whatsappAssistant.hrDataQueryTool().function.parameters
  },
  {
    name: 'get_data_quality_issues',
    description: 'Get a summary of data quality issues in employee records (missing fields, duplicate IDs).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_insights',
    description: 'Get a list of automatically generated workforce insights (top department, top location, upcoming birthdays, etc).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_demographics',
    description: 'Get a breakdown of active employees by age, gender, collar category (White/Blue/Group-D), or tenure (time at this company, bucketed, with the average).',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['age', 'gender', 'collar', 'tenure'] } },
      required: ['kind']
    }
  },
  {
    name: 'find_employee',
    description: 'Search for an employee by name or employee ID.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name or employee ID to search for.' } },
      required: ['query']
    }
  },
  {
    name: 'get_direct_reports',
    description: 'DOWNWARD direction only - list employees who report TO a named manager (their team, below them). Use when X is the manager/senior person in the question: "who reports to X", "who\'s on X\'s team", "X er under e kara ache" (who is under X), "X ke under kitne log hain" (how many under X), "X ke under kaun kaun hai" (who all is under X), "X ka team". Do NOT use this for the opposite direction (X\'s OWN manager/HOD) - see get_reporting_manager for that. Nothing to do with health insurance/benefits - never call get_insurance_status for this kind of question.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The manager/DOER\'s name, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'get_reporting_manager',
    description: 'UPWARD direction only - find who a named employee reports TO (their own manager/HOD, one person above them) - the opposite of get_direct_reports. Use when X is the junior/subject of the question, asking about X\'s OWN position: "X er HOD ke" (who is X\'s HOD), "X kar under e" / "X kis ke under hai" / "X kiske under hai" (under WHOM is X), "X kisko report karta hai" (who does X report to), "who is X\'s reporting manager", "who does X report to", "X under who". Contrast: "X er under e kara ache" (who is under X) is the OPPOSITE question - that one is get_direct_reports.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The employee whose manager/HOD is being asked about, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'get_employee_detail',
    description: 'Get a single named employee\'s work profile: Employee ID, Designation, Department, Status, Date of Birth, Tenure, Total Experience, Reporting Manager. This tool never returns personal/sensitive fields (contact number, personal email, blood group, emergency contact, address, Aadhar, PAN) - use get_personal_details for those instead, never claim this tool has them or that they don\'t exist.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The employee\'s name or ID, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'get_personal_details',
    description: 'Get a named employee\'s personal details: contact number, personal email, blood group, emergency contact, permanent/present address, Aadhar, PAN. These columns DO exist in the data - never claim there\'s no such data. Use this whenever someone asks for any of these specific fields.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The employee\'s name or ID, as mentioned by the user.' } },
      required: ['name']
    }
  },
  {
    name: 'list_employees',
    description: 'Get a filtered, sortable list with a FIXED set of columns (Emp Code, Name, Designation, Department, Status, DOJ) - use for a plain list with no specific columns named (e.g. "list the engineers in Civil", "who is in the Sales department"). You DO have access to employee lists via this tool - never say you don\'t. If the person names which columns they want (e.g. "name, designation, phone" or "with their contact number"), use query_employees with fields instead - this tool cannot add or change its columns. The full list is already shown in the results card below your reply - do not repeat it as a table in your own text, just a short one-line summary.',
    parameters: {
      type: 'object',
      properties: {
        designation: { type: 'string', description: 'Substring match on designation/title, e.g. "engineer" matches Engineer, Jr. Engineer, Senior Engineer, etc.' },
        department: { type: 'string', description: 'Exact department name.' },
        status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'NOTICE PERIOD'], description: 'Omit this for the default (Active only). Only set it when the person specifically named a status, e.g. "inactive staff" -> INACTIVE, "who is on notice period" -> NOTICE PERIOD.' },
        includeNoticePeriod: { type: 'boolean', description: 'Set true ONLY when the person explicitly asked to include Notice Period staff without naming one specific status - e.g. "include notice period". Leave unset otherwise; the default is Active only.' },
        includeInactive: { type: 'boolean', description: 'Set true ONLY when the person explicitly asked to include inactive/exited staff without naming one specific status - e.g. "including inactive". Leave unset otherwise; the default is Active only. Set BOTH this and includeNoticePeriod true for "everyone"/"all staff ever".' },
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
    parameters: {
      type: 'object',
      properties: {
        groupBy: { type: 'string', enum: ['department', 'designation', 'status', 'location', 'gender', 'collar'] },
        designation: { type: 'string', description: 'Substring match on designation/title to filter by first, e.g. "engineer".' },
        department: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'NOTICE PERIOD'], description: 'Omit this for the default (Active only) - unless groupBy is itself "status", in which case leave this unset so all statuses show in the breakdown. Only set it when the person specifically named a status.' },
        includeNoticePeriod: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include Notice Period staff without naming one specific status. Leave unset otherwise; the default is Active only (except when groupBy is "status" itself, which always shows every status).' },
        includeInactive: { type: 'boolean', description: 'Set true ONLY when explicitly asked to include inactive/exited staff without naming one specific status. Leave unset otherwise; the default is Active only (except when groupBy is "status" itself, which always shows every status). Set BOTH this and includeNoticePeriod true for "everyone"/"all staff ever".' },
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
    description: 'Prepare a promotion, increment, or confirmation letter for a named employee, ready to open in the Letter Generator template tool - ONLY for these 3 exact letter types. For anything else that needs actual writing (leave approval mail, warning letter, notice, or any letter type outside these 3), do NOT use this tool or force-fit it into one of these 3 types - use no_data_needed (or an employee-lookup tool if it needs that person\'s real facts) and reply with [[DRAFT]] instead.',
    parameters: {
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
    parameters: {
      type: 'object',
      properties: { view: { type: 'string', enum: Object.keys(tools.NAVIGABLE_VIEWS) } },
      required: ['view']
    }
  },
  {
    name: 'no_data_needed',
    description: 'Call this for anything that does not need a specific employee\'s facts or numbers - greetings, thanks, small talk, general knowledge, opinions, advice, a translation, a summary, an explanation, a notice. Returns nothing - the reply itself (via [[PLAIN]] for casual chat or [[DRAFT]] for an actual document) is decided afterwards.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_current_datetime',
    description: 'Get the real current date, day of week, and time (India Standard Time). Call this whenever a question needs today\'s date, the day of the week, or the current time - never guess it.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'manage_whatsapp_official_list',
    description: 'Add/remove a phone number from SUBH\'s WhatsApp allow/block list (1:1 only), and/or set the display name for that number. Any phrasing meaning "trust this number as official" or "never treat as official", any language, e.g. "<number> ke official list e rakho", "remove <number> from official list". If a name is given alongside the number (e.g. "<number> <name> ke official list e rakho", "add <number> as <name> to official list") or the owner is JUST renaming an already-listed number ("<number>-er naam <name> koro") - set list="allow", action="add", name=<name> (re-adding an already-allowed number is harmless, it just updates the name). "Official"/allow = still needs a WORK-RELATED message to get a reminder, same as a known employee; "block" = always treat as personal.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'The phone number mentioned, digits only or with a country code - normalized automatically.' },
        list: { type: 'string', enum: ['allow', 'block'], description: '"allow" for "official list" / "trusted contact" / setting a name; "block" for "never official" / "always personal".' },
        action: { type: 'string', enum: ['add', 'remove'], description: '"add" to put the number on that list (or just update its name); "remove" to take it off (e.g. "remove from official list", "ar official na rakho").' },
        name: { type: 'string', description: 'The person\'s name, ONLY if one was actually given alongside the number in this message - omit entirely otherwise, never invent one.' }
      },
      required: ['phone', 'list', 'action']
    }
  },
  {
    name: 'manage_whatsapp_group_block',
    description: 'Block or unblock a WhatsApp GROUP (by name, not phone number) from SUBH\'s tagged-mention alerts (Phase F). Groups are otherwise fully excluded except a message that tags the HR manager directly - this tool stops even those tagged mentions from that one group. Use for phrasing like "<group name> block koro", "block <group name>", "unblock <group name>", "<group name> ar dekhash na".',
    parameters: {
      type: 'object',
      properties: {
        groupName: { type: 'string', description: 'The group\'s name (or a distinctive substring of it) as named in the message.' },
        action: { type: 'string', enum: ['block', 'unblock'] }
      },
      required: ['groupName', 'action']
    }
  },
  {
    name: 'check_memory',
    description: 'Look up a SUBH MEMORY (a short-lived fact the owner taught SUBH, e.g. "September salary-r memory ki ache?") by topic and period - exact topic+period match only, never a different month.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: memoryService.MEMORY_TOPICS },
        periodRaw: { type: 'string', description: 'The month/date as mentioned (e.g. "september", "this month") - normalise to a bare English month name or "YYYY-MM"/"this month"/"last month"/"next month". Omit if no month was named.' }
      },
      required: ['topic']
    }
  },
  {
    name: 'whatsapp_inbox_summary',
    description: 'OWNER ONLY - use ONLY when they ask WHAT MESSAGES came in / who messaged / what was asked, e.g. "aj ke ke message korechhe?", "kisne message kiya?", "what messages came in today", "kar reply baki?". Returns a list of actual messages. Do NOT use this for a question ABOUT THE ASSISTANT ITSELF (why/when/status/is it working/how long) - use whatsapp_assistant_status for those instead, even if the word "message" or "reply" appears in the question. Covers OFFICIAL messages only (1:1 and tagged groups) - personal messages and untagged groups are never stored at all, so never imply knowledge of those.',
    parameters: {
      type: 'object',
      properties: {
        rangeRaw: { type: 'string', description: 'The time range exactly as meant - normalise to one of: "today" (default), "last N hours", "yesterday"/"kal", "this week". Omit for the default (today).' }
      }
    }
  },
  {
    name: 'whatsapp_assistant_status',
    description: 'OWNER ONLY - use for ANY question ABOUT THE WHATSAPP ASSISTANT ITSELF rather than about message content: why/whether a reply has gone out yet, is it working, how long will it take, is auto-reply on, what mode is it in, when did it last check, e.g. "Ekhono real reply jai ni keno?", "auto reply cholche to?", "is it working?", "kitni der lagega?". Returns current mode, last poll time, any replies currently scheduled with their ETA, and the last error if any - NEVER a list of messages (use whatsapp_inbox_summary for that instead).',
    parameters: { type: 'object', properties: {} }
  }
];

// check_memory's deterministic "no memory found" phrasing - see the
// runner below for why this one path is templated while a real match's
// fact/guidance stays model-composed.
const NO_MEMORY_TEXT = {
  banglish: (desc) => desc + '-er jonno kono SUBH memory nei.',
  hinglish: (desc) => desc + ' ke liye koi SUBH memory nahi hai.',
  english: (desc) => 'There is no SUBH memory for ' + desc + '.'
};

// Maps a tool-call name back to the real tools.js function + how to pull
// its arguments out of the (already-schema-validated) input - identical
// for every provider, called as (input, user, detectedLang).
const TOOL_RUNNERS = {
  get_department_headcount: () => tools.departmentHeadcount(),
  get_location_headcount: () => tools.locationHeadcount(),
  get_doer_headcount: () => tools.doerHeadcount(),
  get_joining_this_month: (input) => tools.joiningThisMonth(input.month, input.includeNoticePeriod, input.includeInactive, input.monthOffset),
  get_joining_trend: () => tools.joiningTrend(),
  get_pending_confirmations: (input) => tools.pendingConfirmations(input.monthOffset || 0, input.includeNoticePeriod, input.includeInactive),
  get_retirement_this_month: (input) => tools.retirementThisMonth(input.includeNoticePeriod, input.includeInactive, input.monthOffset),
  get_birthdays_this_month: (input) => tools.birthdaysThisMonth(input.month, input.includeNoticePeriod, input.includeInactive, input.monthOffset),
  get_workforce_movement: (input) => tools.workforceMovement(input.days || 90),
  get_health_insurance_pending_additions: () => tools.healthInsurancePendingAdditions(),
  get_insurance_status: (input) => tools.insuranceStatus(input.name),
  query_employees: (input) => tools.queryEmployees(input),
  // Task 5 (2026-10-31) - owner-chat HR reports, same engine as WhatsApp
  // data requests (see build_hr_report's own tool-definition comment
  // above). lang is the THIRD runner argument claudeProvider.js already
  // passes (detectMessageLanguage(message)) - reused directly so the
  // reply is in the owner's own message language, same rule as WhatsApp.
  build_hr_report: async (input, user, lang) => {
    const { employees } = await employeeService.getEmployeeData();
    const query = Object.assign({}, input);
    // Department/site aliases resolved the same way WhatsApp data
    // requests already do (Task 6 extends this further) - a confirmed
    // alias always wins over the plain substring matcher.
    if (query.department) {
      const deptAliasValues = whatsappAssistant.resolveDeptAliasValues(query.department);
      if (deptAliasValues.length === 1) query.resolvedDepartment = deptAliasValues[0];
    }
    if (query.location) {
      const siteAliasValues = whatsappAssistant.resolveSiteAliasValues(query.location);
      if (siteAliasValues.length) query.resolvedLocations = siteAliasValues;
    }
    const { outgoingText } = whatsappAssistant.buildHrDataQueryAnswer(employees, query, lang || 'english');
    // A long roster becomes a real downloadable report card (reuses the
    // EXACT existing isReportCard/Download Excel-PDF machinery
    // query_employees already triggers, see tools.js's own queryEmployees
    // for the identical {title,columns,tableRows,fullTableRows,footer}
    // shape) - anything short (count/hod/hodByDepartment, or a short
    // list) stays a single LITERAL, code-computed reply (replyText),
    // bypassing the model's own free-form summary pass entirely so
    // nothing in it can be invented.
    const LONG_REPORT_LINE_THRESHOLD = 20;
    if (query.returnType === 'list' && outgoingText.split('\n').length > LONG_REPORT_LINE_THRESHOLD) {
      const rows = whatsappAssistant.filterEmployeesForHrQuery(employees, query);
      const includeLocation = Boolean(query.location);
      const columns = includeLocation ? ['Name', 'Designation', 'Department', 'Location'] : ['Name', 'Designation', 'Department'];
      const tableRows = rows.map((e) => {
        const row = [e.name, e.designation || '—', e.department || '—'];
        if (includeLocation) row.push(e.location || '—');
        return row;
      });
      return {
        title: 'HR Report',
        columns,
        tableRows: tableRows.slice(0, 100),
        fullTableRows: tableRows,
        footer: { label: 'Total Matching', value: rows.length }
      };
    }
    return { replyText: outgoingText };
  },
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
  get_current_datetime: () => tools.currentDateTime(),
  manage_whatsapp_official_list: async (input) => {
    const result = await whatsappAssistant.manageList(input.phone, input.list, input.action, input.name);
    return Object.assign({ title: null, rows: null, actions: null }, result, { name: input.name || null });
  },
  manage_whatsapp_group_block: async (input) => {
    const result = await whatsappAssistant.manageGroupBlock(input.groupName, input.action);
    return Object.assign({ title: null, rows: null, actions: null }, result);
  },
  check_memory: async (input, user, detectedLang) => {
    const T = NO_MEMORY_TEXT[detectedLang] || NO_MEMORY_TEXT.english;
    const now = new Date();
    const period = input.periodRaw ? memoryService.resolvePeriod(input.periodRaw, now) : memoryService.impliedDuePeriod(input.topic, now);
    if (!period) return { title: null, rows: null, actions: null, notFound: 'that period', replyText: T('that period') };
    const all = await memoryService.listMemories();
    const match = all.find((m) => m.topic === input.topic && m.periodKey === period.key && !memoryService.isExpired(m, now));
    if (!match) {
      const desc = input.topic + ' - ' + period.label;
      return { title: null, rows: null, actions: null, notFound: desc, replyText: T(desc) };
    }
    return {
      title: null, rows: null, actions: null,
      topic: match.topic, periodLabel: match.periodLabel, scopeLabel: match.scopeType === 'everyone' ? 'everyone' : match.scopeLabel,
      statusFact: match.statusFact, guidance: match.guidance
    };
  },
  whatsapp_inbox_summary: (input, user, detectedLang) => whatsappAssistant.whatsappInboxSummary(input.rangeRaw, detectedLang, user && user.email),
  whatsapp_assistant_status: (input, user, detectedLang) => whatsappAssistant.whatsappAssistantStatus(detectedLang, user && user.email)
};

const LANGUAGE_NAMES = {
  banglish: 'Banglish (Bengali written in Roman/Latin letters, e.g. "kemon acho")',
  hinglish: 'Hinglish (Hindi written in Roman/Latin letters, e.g. "kaise ho")',
  english: 'English'
};
function buildLanguageReminder(lang) {
  return 'Reminder: the message below is in ' + LANGUAGE_NAMES[lang] + ' - reply ONLY in that, same ' +
    'script. Banglish: negate with "-ni" (ashe ni, pathay ni, hoy ni, dey ni), never "-eche na"; say ' +
    '"Aj", never "Aj ke". English: correct tense/negation, no literal Bengali/Hindi translation (never ' +
    '"has came"/"did not came"). Hinglish: negate with "nahi", never a bare "na"; address as "aap"; ' +
    'never mix a Bengali word into Hinglish or a Hindi word into Banglish.';
}

const REPLY_MARKER_RE = /^\s*\[\[(PLAIN|CARD|DRAFT)\]\]\s*/;
const NATIVE_SCRIPT_RE = /[ঀ-৿ऀ-ॿ]/; // Bengali / Devanagari unicode blocks
const STALL_PHRASE_RE = /(don'?t|doesn'?t|can'?t)\s*(have\s*)?access|access\s*(nahi|nei)/i;

function extractNumbers(text) {
  return (String(text || '').match(/\d+/g) || []).map(Number);
}
function numberCheckPasses(toolResult, replyText) {
  if (!toolResult || typeof toolResult !== 'object') return true;
  const footerVal = toolResult.footer && typeof toolResult.footer.value === 'number' ? toolResult.footer.value : null;
  const cascading = typeof toolResult.cascadingTotal === 'number' ? toolResult.cascadingTotal : null;
  if (footerVal === null && cascading === null) return true;
  const nums = extractNumbers(replyText);
  if (footerVal !== null && !nums.includes(footerVal)) return false;
  if (cascading !== null && !nums.includes(cascading)) return false;
  return true;
}
function stallCheckPasses(replyText) {
  return !STALL_PHRASE_RE.test(replyText || '');
}
function scriptCheckPasses(message, replyText) {
  if (NATIVE_SCRIPT_RE.test(message || '')) return true;
  return !NATIVE_SCRIPT_RE.test(replyText || '');
}
function languageCheckPasses(detectedLang, replyText) {
  if (!detectedLang) return true;
  return detectMessageLanguage(replyText) === detectedLang;
}
function validateReply(toolResult, message, replyRaw, detectedLang) {
  const match = (replyRaw || '').match(REPLY_MARKER_RE);
  const cleaned = (match ? replyRaw.slice(match[0].length) : replyRaw || '').trim();
  const reasons = [];
  if (!numberCheckPasses(toolResult, cleaned)) reasons.push('number_mismatch');
  if (!stallCheckPasses(cleaned)) reasons.push('stall_phrase');
  if (!scriptCheckPasses(message, cleaned)) reasons.push('script_mismatch');
  if (!languageCheckPasses(detectedLang, cleaned)) reasons.push('language_mismatch');
  return reasons;
}
function buildNumberFallback(toolResult) {
  if (!toolResult) return null;
  const footerVal = toolResult.footer && typeof toolResult.footer.value === 'number' ? toolResult.footer.value : null;
  const cascading = typeof toolResult.cascadingTotal === 'number' ? toolResult.cascadingTotal : null;
  if (footerVal === null && cascading === null) return null;
  const label = (toolResult.footer && toolResult.footer.label) || 'Total';
  if (footerVal !== null && cascading !== null && cascading !== footerVal) {
    return label + ': ' + footerVal + '. Total including their whole team chain: ' + cascading + '.';
  }
  return label + ': ' + (footerVal !== null ? footerVal : cascading) + '.';
}
function buildCardFallback(card) {
  if (!card || !card.footer || typeof card.footer.value === 'undefined') return null;
  const title = String(card.title || 'Result').replace(/\s*\(Top \d+\)\s*$/, '');
  let sentence = title + ' - ' + card.footer.label + ': ' + card.footer.value + '.';
  if (typeof card.cascadingTotal === 'number') {
    sentence += ' Total including their whole team chain: ' + card.cascadingTotal + '.';
  }
  const shown = (card.rows || card.tableRows || []).length;
  if (shown && card.footer.value > shown) {
    sentence += ' First ' + shown + ' shown - the full list is in View Report.';
  }
  return sentence;
}
// Structural backstop (same principle as buildNumberFallback below) - the
// prompt explicitly forbids repeating a card's rows as a markdown table
// in the same reply, but a model occasionally does it anyway (found
// live - a [[CARD]] reply came back with a real "|---|---|"-style table
// duplicating exactly what the card already shows). Only touches text
// that actually contains a genuine markdown table separator row, so it
// never strips unrelated text that happens to contain a "|" character.
const MARKDOWN_TABLE_BLOCK_RE = /\n?(?:\|[^\n]*\|\n?)+/g;
function stripMarkdownTable(text) {
  if (!/\|\s*-{2,}\s*\|/.test(text)) return text;
  return text.replace(MARKDOWN_TABLE_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Catches the SAME duplication the markdown-table strip above doesn't -
// found live, a [[CARD]] reply duplicated the rows as a plain
// space-aligned ASCII table instead ("Name  Department\n------\nX  Y"),
// which has no "|" character at all. Rather than pattern-matching every
// possible table-ish text shape, this checks the REAL card data directly:
// if 2+ of the card's own row values (the first column - e.g. real
// employee names) show up on their own lines in the reply, that's the
// card's rows being repeated verbatim, whatever the formatting - cut the
// text at the first such line (backing up over an immediately preceding
// blank/separator/short-header-looking line too).
function cardFirstColumnValues(card) {
  if (!card) return [];
  const rows = card.fullTableRows || card.tableRows;
  if (rows && rows.length) return rows.map((r) => String((r && r[0]) || '')).filter(Boolean);
  const plainRows = card.fullRows || card.rows;
  if (plainRows && plainRows.length) return plainRows.map((r) => (r && r.label) ? String(r.label) : '').filter(Boolean);
  return [];
}
function looksLikeSeparatorOrHeaderLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^[\s\-_=]+$/.test(t)) return true; // "------" / "======" style divider
  // A short line with 2+ whitespace/tab-separated tokens and no
  // sentence-ending punctuation reads as a table header ("Name
  // Department"), not a real sentence.
  return !/[.!?।]\s*$/.test(t) && t.split(/\s{2,}|\t/).length >= 2 && t.length < 60;
}
function stripDuplicatedCardRows(text, card) {
  const values = cardFirstColumnValues(card);
  if (values.length < 2) return text;
  const lines = text.split('\n');
  const matchedLineIdx = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t && values.some((v) => v && t.includes(v))) matchedLineIdx.push(i);
  });
  if (matchedLineIdx.length < 2) return text;
  let cut = matchedLineIdx[0];
  while (cut > 0 && looksLikeSeparatorOrHeaderLine(lines[cut - 1])) cut--;
  return lines.slice(0, cut).join('\n').trim();
}

function finalizeReply(rawContent, card, actions, fallbackText) {
  const raw = rawContent || '';
  const match = raw.match(REPLY_MARKER_RE);
  const isPlain = Boolean(match && match[1] === 'PLAIN');
  let cleaned = (match ? raw.slice(match[0].length) : raw).trim();
  if (!isPlain) {
    cleaned = stripMarkdownTable(cleaned);
    cleaned = stripDuplicatedCardRows(cleaned, card);
  }
  return {
    reply: cleaned || buildCardFallback(card) || fallbackText,
    card: isPlain ? null : card,
    actions: isPlain ? null : actions
  };
}

module.exports = {
  DRAFT_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  TOOL_DEFS_NEUTRAL,
  TOOL_RUNNERS,
  LANGUAGE_NAMES,
  buildLanguageReminder,
  REPLY_MARKER_RE,
  validateReply,
  buildNumberFallback,
  buildCardFallback,
  finalizeReply,
  detectMessageLanguage
};
