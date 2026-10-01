const list = document.getElementById('list');
const subtitle = document.getElementById('subtitle');
const tabs = document.getElementById('tabs');
const sectionHead = document.getElementById('sectionHead');
const sectionTitle = document.getElementById('sectionTitle');
const searchRow = document.getElementById('searchRow');
const searchInput = document.getElementById('searchInput');

const CATEGORY_LABEL = {
  recent: 'Recent mail',
  unread: 'Unread',
  important: 'Important & unread',
  candidates: 'Job Applications',
  joinings: 'Upcoming Joinings'
};
const bodyCache = {};
let activeCategory = 'recent';
let activeSearch = '';
let searchDebounce;

const refreshBtn = document.getElementById('refreshBtn');
refreshBtn.addEventListener('click', async () => {
  if (refreshBtn.classList.contains('spinning')) return;
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;
  try {
    await Promise.all([loadCounts(), loadCategory(activeCategory)]);
  } finally {
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
  }
});

tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-category]');
  if (!btn) return;
  setActiveTab(btn.dataset.category);
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    activeSearch = searchInput.value.trim();
    loadCategory(activeCategory);
  }, 350);
});

function setActiveTab(category) {
  activeCategory = category;
  activeSearch = '';
  searchInput.value = '';
  tabs.querySelectorAll('[data-category]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.category === category));
  });
  searchRow.hidden = category === 'joinings';
  sectionHead.className = 'section-head ' + category;
  sectionTitle.textContent = CATEGORY_LABEL[category];
  loadCategory(category);
}

async function loadCounts() {
  try {
    const res = await fetch('api/counts');
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to load counts');
    const data = await res.json();
    subtitle.textContent = data.emailAddress;
    document.getElementById('count-unread').textContent = data.counts.unread;
    document.getElementById('count-important').textContent = data.counts.important;
    document.getElementById('count-recent').textContent = data.counts.recent;
    document.getElementById('count-candidates').textContent = data.counts.candidates;
  } catch (err) {
    subtitle.textContent = 'Error loading counts';
  }
}

let currentRequestId = 0;

async function loadCategory(category) {
  const requestId = ++currentRequestId;
  list.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  if (category === 'joinings') {
    return loadJoinings(requestId);
  }
  const params = new URLSearchParams();
  if (activeSearch) params.set('q', activeSearch);
  const qs = params.toString();
  try {
    const res = await fetch('api/messages/' + category + (qs ? '?' + qs : ''));
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to load');
    const data = await res.json();
    if (requestId !== currentRequestId) return; // a newer tab/search has since started
    render(data, category);
  } catch (err) {
    if (requestId !== currentRequestId) return;
    list.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

function render(data, category) {
  if (!data.items.length) {
    const empty = activeSearch ? 'No matches' : (category === 'important' ? 'None 🎉' : 'None');
    list.innerHTML = '<div class="empty">' + empty + '</div>';
    return;
  }
  let html = data.items.map((item) => cardHtml(item)).join('');
  if (data.truncated) {
    html += '<div class="empty">Showing latest ' + data.items.length + ' of ' + data.total + '</div>';
  }
  list.innerHTML = html;
  prefetchBodies(data.items);
}

const PREFETCH_CONCURRENCY = 6;

function prefetchBodies(items) {
  const toFetch = items.filter((item) => !bodyCache[item.id]);
  let index = 0;
  async function worker() {
    while (index < toFetch.length) {
      const item = toFetch[index++];
      try {
        const res = await fetch('api/message/' + item.id);
        if (res.ok) {
          const data = await res.json();
          bodyCache[item.id] = data.bodyText;
        }
      } catch {
        // Silent — falls back to the on-demand fetch in toggleBody if this
        // one didn't make it into the cache in time.
      }
    }
  }
  Array.from({ length: Math.min(PREFETCH_CONCURRENCY, toFetch.length) }, worker);
}

async function loadJoinings(requestId) {
  try {
    const res = await fetch('api/joinings');
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to load');
    const data = await res.json();
    if (requestId !== currentRequestId) return; // a newer tab/search has since started
    document.getElementById('count-joinings').textContent = data.total;
    renderJoiningsTable(data);
  } catch (err) {
    if (requestId !== currentRequestId) return;
    list.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

function renderJoiningsTable(data) {
  if (!data.items.length) {
    list.innerHTML = '<div class="empty">No joinings in the next 3 months</div>';
    return;
  }

  const withUrgency = data.items.map((item) => ({ item, days: daysUntil(item.doj) }));
  const thisWeek = withUrgency.filter((x) => x.days !== null && x.days <= 7).length;
  const thisMonth = withUrgency.filter((x) => x.days !== null && x.days > 7 && x.days <= 30).length;

  const first = data.items[0];
  const last = data.items[data.items.length - 1];
  const rangeLabel =
    first && last
      ? formatJoiningDate(first.doj) + ' – ' + formatJoiningDate(last.doj)
      : '';

  const rows = withUrgency
    .map(({ item, days }, i) => {
      const bucket = urgencyBucket(days);
      return (
        '<tr class="' + bucket.rowClass + '">' +
          '<td class="col-sl">' + (i + 1) + '</td>' +
          '<td class="col-name">' + escapeHtml(item.name) + '</td>' +
          '<td>' + escapeHtml(item.designation || '—') + '</td>' +
          '<td>' + escapeHtml(item.company || '—') + '</td>' +
          '<td class="col-doj">' +
            '<span class="doj-date">' + escapeHtml(formatJoiningDate(item.doj)) + '</span>' +
            '<span class="doj-badge ' + bucket.badgeClass + '">' + escapeHtml(bucket.label) + '</span>' +
          '</td>' +
        '</tr>'
      );
    })
    .join('');

  list.innerHTML =
    '<div class="report-card">' +
      '<div class="report-header">' +
        '<div>' +
          '<h3>Upcoming Joinings</h3>' +
          '<div class="report-sub">' + data.items.length + ' candidate' + (data.items.length === 1 ? '' : 's') +
            (rangeLabel ? ' · ' + escapeHtml(rangeLabel) : '') +
          '</div>' +
        '</div>' +
        '<div class="report-stats">' +
          (thisWeek ? '<span class="report-stat soon">' + thisWeek + ' this week</span>' : '') +
          (thisMonth ? '<span class="report-stat month">' + thisMonth + ' this month</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="table-wrap">' +
        '<table class="joinings-table">' +
          '<thead><tr><th>#</th><th>Candidate</th><th>Designation</th><th>Company</th><th>DOJ</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';
}

function daysUntil(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const dojUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((dojUtc - todayUtc) / 86400000);
}

function urgencyBucket(days) {
  if (days === null) return { label: '—', badgeClass: 'later', rowClass: '' };
  if (days === 0) return { label: 'Today', badgeClass: 'soon', rowClass: 'row-soon' };
  if (days === 1) return { label: 'Tomorrow', badgeClass: 'soon', rowClass: 'row-soon' };
  if (days > 1 && days <= 7) return { label: 'in ' + days + ' days', badgeClass: 'soon', rowClass: 'row-soon' };
  if (days > 7 && days <= 30) return { label: 'in ' + days + ' days', badgeClass: 'month', rowClass: '' };
  if (days > 30) return { label: 'in ' + Math.round(days / 7) + ' wks', badgeClass: 'later', rowClass: '' };
  return { label: 'overdue', badgeClass: 'soon', rowClass: 'row-soon' };
}

function formatJoiningDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function extractFirstName(fromHeader) {
  if (!fromHeader) return 'Sir/Madam';
  const match = fromHeader.match(/^"?([^"<]+)"?\s*<.*>$/);
  const displayName = match ? match[1].trim() : '';
  if (!displayName) return 'Sir/Madam';
  return displayName.split(/[\s,]+/)[0] || 'Sir/Madam';
}

function defaultReplyText(item) {
  if (activeCategory !== 'candidates') return '';
  const name = extractFirstName(item.from);
  return (
    'Dear ' + name + ',\n\n' +
    'Thank you for your interest in joining our organisation and for sharing your profile with us.\n\n' +
    'This is to confirm that we have received your application. Our team will review your profile against our current and upcoming requirements, and we will reach out to you as soon as a suitable opening matches your profile.\n\n' +
    'We appreciate your patience in the meantime.\n\n' +
    'Warm regards,\nAlcove Realty – HR Team'
  );
}

function cardHtml(item) {
  const id = 'm_' + item.id;
  return '' +
    '<div class="card' + (item.important ? ' important' : '') + (item.unread ? ' is-unread' : '') + '">' +
      '<div class="card-top">' +
        '<span class="from">' + escapeHtml(item.from) + '</span>' +
        '<div class="card-top-right">' +
          '<span class="time">' + escapeHtml(formatDate(item.date)) + '</span>' +
          '<button class="delete-btn" data-delete="' + item.id + '" aria-label="Move to Trash" title="Move to Trash">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="open-toggle" data-open="' + id + '" role="button" tabindex="0">' +
        '<div class="subject">' + escapeHtml(item.subject) + '</div>' +
        '<div class="snippet">' + escapeHtml(item.snippet) + '</div>' +
      '</div>' +
      '<div class="full-body" id="' + id + '_body"></div>' +
      '<button class="reply-btn" data-toggle="' + id + '_reply">Reply</button>' +
      '<div class="composer" id="' + id + '_reply">' +
        '<textarea id="ta_' + id + '" placeholder="Type your reply…">' + escapeHtml(defaultReplyText(item)) + '</textarea>' +
        '<div class="composer-actions">' +
          '<button class="btn-send" data-send="' + item.id + '" data-box="' + id + '_reply" data-ta="' + id + '">Send reply</button>' +
          '<button class="btn-cancel" data-toggle="' + id + '_reply">Cancel</button>' +
        '</div>' +
        '<div class="status-msg" id="st_' + id + '"></div>' +
      '</div>' +
    '</div>';
}

list.addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('[data-delete]');
  if (deleteBtn) {
    handleDelete(deleteBtn.dataset.delete, deleteBtn);
    return;
  }
  const openEl = e.target.closest('[data-open]');
  if (openEl) {
    toggleBody(openEl.dataset.open);
    return;
  }
  const toggleId = e.target.getAttribute('data-toggle');
  if (toggleId) {
    document.getElementById(toggleId).classList.toggle('open');
    return;
  }
  const messageId = e.target.getAttribute('data-send');
  if (messageId) {
    sendReply(messageId, e.target.getAttribute('data-box'), e.target.getAttribute('data-ta'), e.target);
  }
});

async function handleDelete(messageId, button) {
  if (!confirm('Move this email to Trash?')) return;
  button.disabled = true;
  try {
    const res = await fetch('api/message/' + messageId, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete');
    loadCounts();
    loadCategory(activeCategory);
  } catch (err) {
    alert('Could not move to Trash: ' + err.message);
    button.disabled = false;
  }
}

list.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const openEl = e.target.closest('[data-open]');
  if (openEl) {
    e.preventDefault();
    toggleBody(openEl.dataset.open);
  }
});

async function toggleBody(id) {
  const box = document.getElementById(id + '_body');
  const isOpen = box.classList.toggle('open');
  if (!isOpen || box.dataset.loaded) return;

  const messageId = id.slice(2);
  if (bodyCache[messageId]) {
    box.innerHTML = '<div class="body-text">' + escapeHtml(bodyCache[messageId]) + '</div>';
    box.dataset.loaded = '1';
    return;
  }
  box.innerHTML = '<div class="loading-inline"><div class="spinner spinner-sm"></div></div>';
  try {
    const res = await fetch('api/message/' + messageId);
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to load message');
    const data = await res.json();
    bodyCache[messageId] = data.bodyText;
    box.innerHTML = '<div class="body-text">' + escapeHtml(data.bodyText) + '</div>';
    box.dataset.loaded = '1';
  } catch (err) {
    box.innerHTML = '<div class="status-msg error">' + escapeHtml(err.message) + '</div>';
  }
}

async function sendReply(messageId, boxId, taId, button) {
  const textarea = document.getElementById('ta_' + taId);
  const status = document.getElementById('st_' + taId);
  const replyText = textarea.value.trim();
  if (!replyText) return;

  button.disabled = true;
  status.className = 'status-msg';
  status.textContent = 'Sending…';

  try {
    const res = await fetch('api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, replyText })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    status.className = 'status-msg success';
    status.textContent = 'Sent ✓';
    setTimeout(() => {
      loadCounts();
      loadCategory(activeCategory);
    }, 700);
  } catch (err) {
    status.className = 'status-msg error';
    status.textContent = escapeHtml(err.message);
    button.disabled = false;
  }
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

setActiveTab('recent');
loadCounts();
