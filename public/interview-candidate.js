(function () {
  var token = window.location.pathname.split('/').filter(Boolean).pop();
  var loadingEl = document.getElementById('ivLoading');
  var panelEl = document.getElementById('ivPanel');
  var stateAlready = document.getElementById('ivStateAlready');
  var stateDone = document.getElementById('ivStateDone');
  var stateError = document.getElementById('ivStateError');
  var stateErrorMsg = document.getElementById('ivStateErrorMsg');
  var form = document.getElementById('ivForm');
  var submitBtn = document.getElementById('ivSubmitBtn');
  var errorBox = document.getElementById('ivError');
  var workedSelect = document.getElementById('f_workedOnAlcoveProjects');
  var alcoveDetailsWrap = document.getElementById('f_alcoveProjectsDetailsWrap');
  var cvInput = document.getElementById('f_cv');
  var cvLinkInput = document.getElementById('f_cvLink');
  var uploadBox = document.getElementById('ivUploadBox');
  var uploadContent = document.getElementById('ivUploadContent');
  var uploadError = document.getElementById('ivUploadError');
  var CV_ICON_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';
  var CHECK_ICON_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  function showOnly(el) {
    [loadingEl, panelEl, stateAlready, stateDone, stateError].forEach(function (e) {
      e.hidden = e !== el;
    });
  }

  workedSelect.addEventListener('change', function () {
    alcoveDetailsWrap.hidden = workedSelect.value !== 'Yes';
  });

  function resetUploadBox() {
    uploadBox.classList.remove('uploading', 'has-file');
    uploadContent.innerHTML =
      '<div class="iv-upload-icon">' + CV_ICON_SVG + '</div>' +
      '<div class="iv-upload-title">Tap to upload or choose file</div>' +
      '<div class="iv-upload-hint">PDF, DOC, DOCX (Max 4MB)</div>';
  }

  var CV_MAX_BYTES = 4 * 1024 * 1024;
  var CV_ALLOWED_TYPES = {
    'application/pdf': true,
    'application/msword': true,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true
  };

  cvInput.addEventListener('change', function () {
    var file = cvInput.files && cvInput.files[0];
    uploadError.hidden = true;
    cvLinkInput.value = '';
    if (!file) { resetUploadBox(); return; }

    // Checked here too (not just server-side) so an obviously invalid file
    // never even reaches the network - the server still re-checks both,
    // since a client-side check is only ever a courtesy, not a guarantee.
    if (file.size > CV_MAX_BYTES) {
      cvInput.value = '';
      resetUploadBox();
      uploadError.textContent = 'That file is larger than 4MB - please upload a smaller file.';
      uploadError.hidden = false;
      return;
    }
    if (!CV_ALLOWED_TYPES[file.type]) {
      cvInput.value = '';
      resetUploadBox();
      uploadError.textContent = 'Please upload a PDF, DOC, or DOCX file.';
      uploadError.hidden = false;
      return;
    }

    uploadBox.classList.add('uploading');
    uploadBox.classList.remove('has-file');
    uploadContent.innerHTML =
      '<div class="iv-upload-spinner"></div>' +
      '<div class="iv-upload-title">Uploading&hellip;</div>';

    var fd = new FormData();
    fd.append('cv', file);

    fetch('/api/interview/candidate/' + encodeURIComponent(token) + '/cv', {
      method: 'POST',
      body: fd
    })
      .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
      .then(function (res) {
        if (!res.data.ok) {
          uploadBox.classList.remove('uploading');
          resetUploadBox();
          cvInput.value = '';
          uploadError.textContent = res.data.error || 'Could not upload the file. Please try again.';
          uploadError.hidden = false;
          return;
        }
        cvLinkInput.value = res.data.cvLink;
        uploadBox.classList.remove('uploading');
        uploadBox.classList.add('has-file');
        uploadContent.innerHTML =
          '<div class="iv-upload-icon">' + CHECK_ICON_SVG + '</div>' +
          '<div class="iv-upload-filename">' + res.data.cvName.replace(/</g, '&lt;') + '</div>' +
          '<button type="button" class="iv-upload-remove" id="ivUploadRemoveBtn">Remove &amp; choose another file</button>';
        document.getElementById('ivUploadRemoveBtn').addEventListener('click', function (e) {
          e.preventDefault();
          cvInput.value = '';
          cvLinkInput.value = '';
          resetUploadBox();
        });
      })
      .catch(function () {
        uploadBox.classList.remove('uploading');
        resetUploadBox();
        cvInput.value = '';
        uploadError.textContent = 'Something went wrong uploading the file. Please check your connection and try again.';
        uploadError.hidden = false;
      });
  });

  function showError(msg) {
    stateErrorMsg.textContent = msg || 'This link is invalid or has expired.';
    showOnly(stateError);
  }

  fetch('/api/interview/candidate/' + encodeURIComponent(token))
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
      showOnly(panelEl);
    })
    .catch(function () { showError('Something went wrong loading this form. Please try again.'); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox.hidden = true;

    // CV upload is optional - only actually blocks submission if a file
    // was picked and is still mid-upload (submitting before it finishes
    // would leave cvLink empty even though the candidate meant to attach one).
    if (uploadBox.classList.contains('uploading')) {
      errorBox.textContent = 'Please wait for the CV upload to finish before submitting.';
      errorBox.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    var fd = new FormData(form);
    var payload = {};
    fd.forEach(function (value, key) { payload[key] = value; });

    fetch('/api/interview/candidate/' + encodeURIComponent(token), {
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
          submitBtn.textContent = 'Submit Application';
          return;
        }
        showOnly(stateDone);
      })
      .catch(function () {
        errorBox.textContent = 'Something went wrong. Please check your connection and try again.';
        errorBox.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Application';
      });
  });
})();
