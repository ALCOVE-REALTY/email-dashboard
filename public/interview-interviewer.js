(function () {
  var token = window.location.pathname.split('/').filter(Boolean).pop();
  var loadingEl = document.getElementById('ivLoading');
  var panelEl = document.getElementById('ivPanel');
  var stateAlready = document.getElementById('ivStateAlready');
  var stateDone = document.getElementById('ivStateDone');
  var stateWait = document.getElementById('ivStateWait');
  var stateError = document.getElementById('ivStateError');
  var stateErrorMsg = document.getElementById('ivStateErrorMsg');
  var form = document.getElementById('ivForm');
  var submitBtn = document.getElementById('ivSubmitBtn');
  var errorBox = document.getElementById('ivError');
  var candidateBox = document.getElementById('ivCandidateBox');
  var gradeFieldsEl = document.getElementById('ivGradeFields');
  var panelistRowsEl = document.getElementById('ivPanelistRows');
  var addPanelistBtn = document.getElementById('ivAddPanelist');
  var overallBody = document.getElementById('ivOverallBody');
  var statusSelect = document.getElementById('f_interviewStatus');
  var replacementSelect = document.getElementById('f_newRejoinedReplacement');
  var replacementFieldWrap = document.getElementById('ivReplacementFieldWrap');
  var replacementNameInput = document.getElementById('f_replacementForName');
  var itSummaryField = document.getElementById('ivItSummaryField');
  var itSummary = document.getElementById('ivItSummary');
  var editItBtn = document.getElementById('ivEditItRequirements');
  var itOverlay = document.getElementById('ivItOverlay');
  var itLaptopCb = document.getElementById('ivItLaptop');
  var itMailCb = document.getElementById('ivItMail');
  var itSimCb = document.getElementById('ivItSim');
  var itNotApplicableCb = document.getElementById('ivItNotApplicable');
  var itLaptopRow = document.getElementById('ivItLaptopRow');
  var itMailRow = document.getElementById('ivItMailRow');
  var itSimRow = document.getElementById('ivItSimRow');
  var itNotApplicableRow = document.getElementById('ivItNotApplicableRow');
  var itError = document.getElementById('ivItError');
  var itOkBtn = document.getElementById('ivItOkBtn');

  var COMPETENCIES = [
    { key: 'gradeIntelligence', label: 'Intelligence' },
    { key: 'gradeAttitude', label: 'Attitude' },
    { key: 'gradePersonality', label: 'Personality' },
    { key: 'gradeConfidence', label: 'Confidence' },
    { key: 'gradeCommunicationSkills', label: 'Communication Skills' },
    { key: 'gradeAcademicPerformance', label: 'Academic Performance' },
    { key: 'gradeJobKnowledge', label: 'Job Knowledge' },
    { key: 'gradeJobSuitability', label: 'Job Suitability' }
  ];
  var GRADES = ['A', 'B+', 'B', 'C', 'D'];
  var GRADE_SCORE = { A: 5, 'B+': 4, B: 3, C: 2, D: 1 };
  var GRADE_DESC = { A: 'Outstanding', 'B+': 'V.Good', B: 'Good', C: 'Average', D: 'Below Average' };

  var CANDIDATE_LABELS = [
    ['name', 'Name'], ['positionAppliedFor', 'Position Applied For'],
    ['contactNo', 'Contact No'], ['email', 'Email'],
    ['qualification', 'Qualification'], ['experience', 'Experience'],
    ['currentPosition', 'Current Position'], ['interviewDate', 'Interview Date'],
    ['interviewPlace', 'Interview Place'], ['interviewMode', 'Interview Mode'],
    ['referenceName', 'Reference Name'], ['presentLastCompany', 'Present/Last Company'],
    ['designation', 'Designation'], ['currentLastSalaryDrawn', 'Current/Last Salary'],
    ['expectedSalary', 'Expected Salary'], ['noticePeriod', 'Notice Period']
  ];

  var computedOverallGrade = '';
  var itConfirmed = false;
  var itValues = { laptop: false, mail: false, sim: false, notApplicable: false };
  var panelEmployees = null; // lazily fetched, cached for the whole session

  function showOnly(el) {
    [loadingEl, panelEl, stateAlready, stateDone, stateWait, stateError].forEach(function (e) {
      e.hidden = e !== el;
    });
  }

  function showError(msg) {
    stateErrorMsg.textContent = msg || 'This link is invalid or has expired.';
    showOnly(stateError);
  }

  // ---------- Evaluation grid ----------

  function buildGradeRow(key, label) {
    var row = document.createElement('div');
    row.className = 'iv-eval-row';
    var labelEl = document.createElement('span');
    labelEl.className = 'iv-eval-row-label';
    labelEl.textContent = label;
    var req = document.createElement('span');
    req.className = 'iv-required';
    req.textContent = '*';
    labelEl.appendChild(req);
    row.appendChild(labelEl);
    var grid = document.createElement('div');
    grid.className = 'iv-grade-grid';
    grid.setAttribute('data-grade-field', key);
    GRADES.forEach(function (g) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'iv-grade-btn';
      btn.setAttribute('data-value', g);
      btn.textContent = g;
      grid.appendChild(btn);
    });
    row.appendChild(grid);
    return row;
  }

  COMPETENCIES.forEach(function (c) {
    gradeFieldsEl.appendChild(buildGradeRow(c.key, c.label));
  });

  function recomputeOverallGrade() {
    var scores = [];
    COMPETENCIES.forEach(function (c) {
      var grid = form.querySelector('[data-grade-field="' + c.key + '"]');
      var active = grid.querySelector('.iv-grade-btn.active');
      if (active) scores.push(GRADE_SCORE[active.getAttribute('data-value')]);
    });
    if (!scores.length) {
      computedOverallGrade = '';
      overallBody.innerHTML = '<span class="iv-overall-placeholder">Select the criteria above to calculate</span>';
      return;
    }
    var avgScore = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
    var percent = Math.round((avgScore / 5) * 100);
    var grade = percent >= 90 ? 'A' : percent >= 70 ? 'B+' : percent >= 50 ? 'B' : percent >= 30 ? 'C' : 'D';
    computedOverallGrade = grade;
    overallBody.innerHTML =
      '<span class="iv-overall-percent">' + percent + '%</span>' +
      '<span class="iv-overall-meta">' +
        '<span class="iv-overall-grade-pill">' + grade + '</span>' +
        '<span class="iv-overall-grade-desc">' + GRADE_DESC[grade] + (scores.length < COMPETENCIES.length ? ' (partial - ' + scores.length + ' of ' + COMPETENCIES.length + ' rated)' : '') + '</span>' +
      '</span>';
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.iv-grade-btn');
    if (!btn) return;
    var grid = btn.closest('.iv-grade-grid');
    Array.prototype.forEach.call(grid.querySelectorAll('.iv-grade-btn'), function (b) {
      b.classList.toggle('active', b === btn);
    });
    recomputeOverallGrade();
  });

  // ---------- IT Requirements popup ----------
  // At least one of Laptop/Official Mail ID/Official SIM, OR "Not
  // Applicable" on its own (a role like Peon/Support Staff that needs none
  // of them) - the two groups are mutually exclusive, so picking one side
  // clears and disables the other rather than letting both be ticked at once.

  function syncItRowStates() {
    var anyItSelected = itLaptopCb.checked || itMailCb.checked || itSimCb.checked;
    [itLaptopRow, itMailRow, itSimRow].forEach(function (row) {
      row.classList.toggle('disabled', itNotApplicableCb.checked);
    });
    [itLaptopCb, itMailCb, itSimCb].forEach(function (cb) { cb.disabled = itNotApplicableCb.checked; });
    itNotApplicableRow.classList.toggle('disabled', anyItSelected);
    itNotApplicableCb.disabled = anyItSelected;
  }

  [itLaptopCb, itMailCb, itSimCb].forEach(function (cb) {
    cb.addEventListener('change', function () {
      if (cb.checked) itNotApplicableCb.checked = false;
      syncItRowStates();
    });
  });
  itNotApplicableCb.addEventListener('change', function () {
    if (itNotApplicableCb.checked) {
      itLaptopCb.checked = false;
      itMailCb.checked = false;
      itSimCb.checked = false;
    }
    syncItRowStates();
  });

  function openItOverlay() {
    itLaptopCb.checked = itValues.laptop;
    itMailCb.checked = itValues.mail;
    itSimCb.checked = itValues.sim;
    itNotApplicableCb.checked = itValues.notApplicable;
    syncItRowStates();
    itError.hidden = true;
    itOverlay.hidden = false;
  }
  function closeItOverlay() { itOverlay.hidden = true; }

  function renderItSummary() {
    itSummary.innerHTML =
      (itValues.notApplicable ? '<span>Not Applicable for this Role</span>' : '') +
      (itValues.laptop ? '<span>Laptop</span>' : '') +
      (itValues.mail ? '<span>Official Mail ID</span>' : '') +
      (itValues.sim ? '<span>Official SIM</span>' : '');
    itSummaryField.hidden = false;
  }

  statusSelect.addEventListener('change', function () {
    if (statusSelect.value === 'Selected') {
      if (itConfirmed) {
        renderItSummary();
      } else {
        openItOverlay();
      }
    } else {
      itSummaryField.hidden = true;
    }
  });

  editItBtn.addEventListener('click', openItOverlay);

  itOkBtn.addEventListener('click', function () {
    if (!itLaptopCb.checked && !itMailCb.checked && !itSimCb.checked && !itNotApplicableCb.checked) {
      itError.hidden = false;
      return;
    }
    itValues = {
      laptop: itLaptopCb.checked,
      mail: itMailCb.checked,
      sim: itSimCb.checked,
      notApplicable: itNotApplicableCb.checked
    };
    itConfirmed = true;
    closeItOverlay();
    renderItSummary();
  });

  itOverlay.addEventListener('click', function (e) {
    if (e.target === itOverlay) closeItOverlay();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !itOverlay.hidden) closeItOverlay();
  });

  // ---------- Replacement name ----------

  replacementSelect.addEventListener('change', function () {
    var isReplacement = replacementSelect.value === 'Replacement';
    replacementFieldWrap.hidden = !isReplacement;
    replacementNameInput.required = isReplacement;
    if (!isReplacement) replacementNameInput.value = '';
  });

  // ---------- Interview Panel List (search-select from active employees) ----------

  function loadPanelEmployees() {
    if (panelEmployees) return Promise.resolve(panelEmployees);
    return fetch('/api/interview/panel-employees')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        panelEmployees = Array.isArray(data.employees) ? data.employees : [];
        return panelEmployees;
      })
      .catch(function () {
        panelEmployees = [];
        return panelEmployees;
      });
  }

  function addPanelistRow() {
    var row = document.createElement('div');
    row.className = 'iv-panelist-row';
    row.innerHTML =
      '<div class="iv-panelist-top">' +
        '<div class="iv-panelist-search-wrap">' +
          '<input type="text" class="iv-panelist-search" placeholder="Search employee by name" autocomplete="off" />' +
          '<ul class="iv-panelist-suggest" hidden></ul>' +
        '</div>' +
        '<button type="button" class="iv-panelist-remove" aria-label="Remove">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>' +
      '</div>' +
      '<div class="iv-panelist-meta" hidden></div>';

    var searchInput = row.querySelector('.iv-panelist-search');
    var suggestEl = row.querySelector('.iv-panelist-suggest');
    var metaEl = row.querySelector('.iv-panelist-meta');
    var selected = null;

    function renderSuggestions(list) {
      if (!list.length) {
        suggestEl.innerHTML = '<li class="empty">No matching employees</li>';
        suggestEl.hidden = false;
        return;
      }
      suggestEl.innerHTML = list.slice(0, 8).map(function (emp, i) {
        return '<li data-idx="' + i + '"><b></b><span></span></li>';
      }).join('');
      Array.prototype.forEach.call(suggestEl.children, function (li, i) {
        li.querySelector('b').textContent = list[i].name;
        li.querySelector('span').textContent = [list[i].designation, list[i].department].filter(Boolean).join(' · ');
        li.addEventListener('click', function () { selectEmployee(list[i]); });
      });
      suggestEl.hidden = false;
    }

    function selectEmployee(emp) {
      selected = emp;
      searchInput.value = emp.name;
      metaEl.hidden = false;
      metaEl.innerHTML =
        (emp.designation ? '<span>Designation: <b>' + escapeHtml(emp.designation) + '</b></span>' : '') +
        (emp.department ? '<span>Dept: <b>' + escapeHtml(emp.department) + '</b></span>' : '');
      suggestEl.hidden = true;
    }

    function escapeHtml(s) {
      var d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }

    searchInput.addEventListener('input', function () {
      selected = null;
      metaEl.hidden = true;
      metaEl.innerHTML = '';
      var needle = searchInput.value.trim().toLowerCase();
      if (!needle) { suggestEl.hidden = true; return; }
      loadPanelEmployees().then(function (all) {
        var matches = all.filter(function (e) { return e.name.toLowerCase().indexOf(needle) !== -1; });
        renderSuggestions(matches);
      });
    });
    searchInput.addEventListener('focus', function () {
      if (searchInput.value.trim() && !selected) searchInput.dispatchEvent(new Event('input'));
    });

    row.querySelector('.iv-panelist-remove').addEventListener('click', function () { row.remove(); });
    row.getSelected = function () { return selected; };
    panelistRowsEl.appendChild(row);
  }

  addPanelistBtn.addEventListener('click', function () { addPanelistRow(); });

  // One delegated listener for every panelist row's suggestion dropdown,
  // rather than a new document-level listener per row (which would leak a
  // reference to each row even after it's removed via its own [x] button).
  document.addEventListener('click', function (e) {
    Array.prototype.forEach.call(panelistRowsEl.querySelectorAll('.iv-panelist-row'), function (row) {
      if (!row.contains(e.target)) {
        var suggestEl = row.querySelector('.iv-panelist-suggest');
        if (suggestEl) suggestEl.hidden = true;
      }
    });
  });

  // ---------- Load ----------

  fetch('/api/interview/interviewer/' + encodeURIComponent(token))
    .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
    .then(function (res) {
      if (res.status === 404 || !res.data.ok) {
        showError(res.data && res.data.error);
        return;
      }
      if (res.data.alreadySubmitted) {
        showOnly(stateAlready);
        return;
      }
      if (res.data.candidateNotReady) {
        showOnly(stateWait);
        return;
      }
      var c = res.data.candidate || {};
      CANDIDATE_LABELS.forEach(function (pair) {
        var key = pair[0], label = pair[1];
        if (!c[key]) return;
        var row = document.createElement('div');
        row.className = 'iv-readonly-row';
        row.innerHTML = '<span></span><span></span>';
        row.children[0].textContent = label;
        row.children[1].textContent = c[key];
        candidateBox.appendChild(row);
      });
      addPanelistRow();
      loadPanelEmployees();
      showOnly(panelEl);
    })
    .catch(function () { showError('Something went wrong loading this form. Please try again.'); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox.hidden = true;

    var payload = {};
    var missingGrade = false;
    COMPETENCIES.forEach(function (c) {
      var grid = form.querySelector('[data-grade-field="' + c.key + '"]');
      var active = grid.querySelector('.iv-grade-btn.active');
      if (!active) { missingGrade = true; return; }
      payload[c.key] = active.getAttribute('data-value');
    });
    if (missingGrade || !computedOverallGrade) {
      errorBox.textContent = 'Please select a grade for every evaluation criterion.';
      errorBox.hidden = false;
      return;
    }
    payload.overallGrade = computedOverallGrade;

    payload.interviewStatus = statusSelect.value;
    if (!payload.interviewStatus) {
      errorBox.textContent = 'Please select an Interview Status.';
      errorBox.hidden = false;
      return;
    }
    if (payload.interviewStatus === 'Selected' && !itConfirmed) {
      errorBox.textContent = 'Please confirm IT Requirements before submitting.';
      errorBox.hidden = false;
      openItOverlay();
      return;
    }
    if (payload.interviewStatus === 'Selected') {
      payload.itLaptop = itValues.laptop ? 'Yes' : '';
      payload.itOfficialMailId = itValues.mail ? 'Yes' : '';
      payload.itOfficialSim = itValues.sim ? 'Yes' : '';
      payload.itNotApplicable = itValues.notApplicable ? 'Yes' : '';
    }

    payload.newRejoinedReplacement = replacementSelect.value;
    if (!payload.newRejoinedReplacement) {
      errorBox.textContent = 'Please select New / Rejoined / Replacement.';
      errorBox.hidden = false;
      return;
    }
    if (payload.newRejoinedReplacement === 'Replacement') {
      payload.replacementForName = replacementNameInput.value.trim();
      if (!payload.replacementForName) {
        errorBox.textContent = 'Please enter the name of replacement.';
        errorBox.hidden = false;
        return;
      }
    }

    payload.interviewerComments = document.getElementById('f_interviewerComments').value.trim();
    if (!payload.interviewerComments) {
      errorBox.textContent = 'Please enter Interviewer Comments.';
      errorBox.hidden = false;
      return;
    }
    // Additional Note is the one deliberately optional field in this form.
    payload.additionalNote = document.getElementById('f_additionalNote').value.trim();

    // Every row shown in the Interview Panel List is mandatory - a row left
    // blank must be removed with its own [x] rather than submitted empty.
    var panelList = [];
    var missingPanelSelection = false;
    Array.prototype.forEach.call(panelistRowsEl.children, function (row) {
      var sel = row.getSelected();
      if (!sel) { missingPanelSelection = true; return; }
      panelList.push(sel);
    });
    if (missingPanelSelection) {
      errorBox.textContent = 'Please select a panel member from the search results for every row, or remove that row.';
      errorBox.hidden = false;
      return;
    }
    if (!panelList.length) {
      errorBox.textContent = 'Please add at least one Interview Panel List member.';
      errorBox.hidden = false;
      return;
    }
    payload.panelList = panelList;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    fetch('/api/interview/interviewer/' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
      .then(function (res) {
        if (!res.data.ok) {
          errorBox.textContent = res.data.error || 'Could not submit the form. Please try again.';
          errorBox.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit Evaluation';
          return;
        }
        showOnly(stateDone);
      })
      .catch(function () {
        errorBox.textContent = 'Something went wrong. Please check your connection and try again.';
        errorBox.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Evaluation';
      });
  });
})();
